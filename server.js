// server.js
// Backend completo en Node.js con Express, Firebase Admin SDK y FaucetPay.

// Carga las variables de entorno desde el archivo .env
import 'dotenv/config';

import express from 'express';
// import bodyParser from 'body-parser'; // express.json() es suficiente para JSON bodies, bodyParser ya no es estrictamente necesario.
import fetch from 'node-fetch'; // Asegúrate de que node-fetch ^2.6.1 sea compatible con ES modules si hay problemas, o actualiza a ^3.x si quieres usar la versión más reciente con fetch global.
import cors from 'cors';
import admin from 'firebase-admin'; // <<-- NUEVO: Importación de Firebase Admin SDK

const app = express();
const PORT = process.env.PORT || 3001; // Usando el puerto 3001, como ya lo tienes configurado
const FAUCETPAY_API_KEY = process.env.FAUCETPAY_API_KEY;
const FAUCETPAY_CURRENCY = 'LTC'; // La moneda que vas a usar para validación/pagos

// Asegúrate de que la API Key esté configurada
if (!FAUCETPAY_API_KEY || FAUCETPAY_API_KEY === 'TU_API_KEY_REAL_DE_FAUCETPAY_AQUI') {
    console.error('ERROR: FAUCETPAY_API_KEY no está configurada en el archivo .env o es el valor por defecto.');
    console.error('Por favor, reemplaza "TU_API_KEY_REAL_DE_FAUCETPAY_AQUI" en .env con tu clave real.');
    process.exit(1); // Sale de la aplicación si la clave no está configurada
}



// --- CONFIGURACIÓN DE FIREBASE ADMIN SDK ---

const serviceAccount = {
    "type": process.env.FIREBASE_TYPE,
    "project_id": process.env.FIREBASE_PROJECT_ID,
    "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
    "private_key": process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    "client_email": process.env.FIREBASE_CLIENT_EMAIL,
    "client_id": process.env.FIREBASE_CLIENT_ID,
    "auth_uri": process.env.FIREBASE_AUTH_URI,
    "token_uri": process.env.FIREBASE_TOKEN_URI,
    "auth_provider_x509_cert_url": process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    "client_x509_cert_url": process.env.FIREBASE_CLIENT_X509_CERT_URL,
    "universe_domain": process.env.FIREBASE_UNIVERSE_DOMAIN
};

// Verifica si las credenciales de Firebase están disponibles
if (!serviceAccount.project_id || !serviceAccount.private_key) {
    console.error('ERROR: Las variables de entorno de Firebase Admin SDK no están configuradas correctamente.');
    console.error('Por favor, asegúrate de que FIREBASE_PROJECT_ID y FIREBASE_PRIVATE_KEY (entre otras) estén definidas en tus variables de entorno de Render.');
    // No salimos si no están, para permitir que el servidor Express arranque, pero las operaciones de Firebase fallarán.
}

try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL // <<-- Usa una variable de entorno para la URL
    });
    console.log("Firebase Admin SDK inicializado correctamente.");
} catch (error) {
    console.error("ERROR: No se pudo inicializar Firebase Admin SDK:", error.message);
    // Considera si quieres que el proceso termine aquí o solo loggear el error.
}

// Obtiene una referencia a la Realtime Database
const db = admin.database();
// --- FIN NUEVO: CONFIGURACIÓN DE FIREBASE ADMIN SDK ---

const REFERRED_USER_REWARD_AMOUNT = 0.00000200; // Ejemplo: 200 Litoshis (0.000002 LTC) para el que es referido
const REFERRER_REWARD_AMOUNT = 0.00000200;     // Ejemplo: 200 Litoshis (0.000002 LTC) para el referente

// Configuración de middlewares
app.use(express.json()); // Middleware para parsear bodies de solicitud JSON
// app.use(cors());

app.use(cors({
    origin: ['http://127.0.0.1:3000', 'http://localhost:3000', 'https://tu-dominio-frontend-en-render.onrender.com'], 
    methods: ['GET', 'POST', 'OPTIONS'], // <--- ¡Asegúrate de que 'OPTIONS' esté aquí!
    allowedHeaders: ['Content-Type', 'Authorization'], 
    credentials: true 
}));






// --- ENDPOINT PARA VALIDAR EL CORREO ELECTRÓNICO CON FAUCETPAY ---
app.post('/api/validate-faucetpay-email', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: 'Email es requerido.' });
    }

    try {
        const FAUCETPAY_API_URL = 'https://faucetpay.io/api/v1/checkaddress';

        const formData = new URLSearchParams();
        formData.append('api_key', FAUCETPAY_API_KEY);
        formData.append('address', email);
        formData.append('currency', FAUCETPAY_CURRENCY);

        const faucetPayResponse = await fetch(FAUCETPAY_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: formData,
        });

        const faucetPayData = await faucetPayResponse.json();

        console.log("Respuesta de FaucetPay:", faucetPayData);

        if (faucetPayData.status === 200 && faucetPayData.message === "OK") {
            res.json({
                success: true,
                message: 'Correo electrónico validado con éxito en FaucetPay.',
                payout_user_hash: faucetPayData.payout_user_hash
            });
        } else if (faucetPayData.status === 456) {
            res.status(400).json({
                success: false,
                message: faucetPayData.message || 'El correo electrónico no pertenece a ningún usuario de FaucetPay.'
            });
        }
        else {
            console.error('Error de FaucetPay al validar correo (otro estado o mensaje):', faucetPayData);
            res.status(500).json({
                success: false,
                message: faucetPayData.message || 'Error desconocido al validar el correo con FaucetPay.'
            });
        }

    } catch (error) {
        console.error('Error interno del servidor al validar el correo:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor al validar el correo.' });
    }
});

// --- ENDPOINT PARA PROCESAR EL RETIRO ---
app.post('/api/request-faucetpay-withdrawal', async (req, res) => {
    // 1. MODIFICADO: Ahora esperamos también el 'userId' del frontend en el cuerpo de la solicitud.
    const { email, amount, userId } = req.body;

    // 2. MODIFICADO: Validamos que el 'userId' también esté presente. Si falta, es un error de solicitud.
    if (!email || !amount || !userId) {
        return res.status(400).json({ success: false, message: 'Email/dirección, monto y ID de usuario son requeridos para el retiro.' });
    }

    // Convertimos el monto recibido (ej. 0.00001 LTC) a un número flotante.
    const withdrawalAmountLTC = parseFloat(amount);

    // Convertir el monto a la unidad más pequeña (litoshis para LTC, satoshis para BTC).
    // FaucetPay espera montos en unidades enteras (ej. 10000 para 0.0001 LTC).
    let amountInSmallestUnit;
    if (FAUCETPAY_CURRENCY === 'LTC') {
        // Multiplicamos por 100 millones porque 1 LTC = 100,000,000 Litoshis.
        amountInSmallestUnit = Math.round(withdrawalAmountLTC * 100_000_000);
    } else if (FAUCETPAY_CURRENCY === 'BTC') {
        // Para BTC también es 100,000,000 Satoshis.
        amountInSmallestUnit = Math.round(withdrawalAmountLTC * 100_000_000);
    } else {
        // Si la moneda configurada no es LTC o BTC, devolvemos un error.
        return res.status(400).json({ success: false, message: 'Moneda no soportada para el retiro.' });
    }

    // 3. NUEVO: Definimos la comisión de retiro. Es CRÍTICO que este valor coincida con el frontend.
    const WITHDRAWAL_FEE = 0.00001000; // Ejemplo: 10000 Litoshis, en formato LTC decimal.
    // Calculamos el costo total del retiro, incluyendo el monto y la comisión.
    const totalCostLTC = withdrawalAmountLTC + WITHDRAWAL_FEE;

    // Referencia al nodo del usuario específico en tu base de datos de Firebase Realtime Database.
    const userRef = db.ref(`users/${userId}`);

    try {
        // 4. NUEVO BLOQUE: Paso de SEGURIDAD: Obtenemos el balance actual del usuario directamente de Firebase.
        // Usamos 'once' para leer el valor una sola vez.
        const snapshot = await userRef.once('value');
        const userData = snapshot.val();
        // Si el usuario no existe o no tiene balance, asumimos 0.
        const currentBalance = userData.balance || 0;

        // 5. NUEVO BLOQUE: Verificamos si el balance actual del usuario es suficiente para cubrir el retiro + la comisión.
        if (currentBalance < totalCostLTC) {
            console.warn(`Intento de retiro fallido para ${userId}: balance insuficiente. Solicitado: ${totalCostLTC}, Actual: ${currentBalance}`);
            // Devolvemos un error si no hay balance suficiente.
            return res.status(400).json({ success: false, message: 'Balance insuficiente para el retiro.' });
        }

        // 6. CÓDIGO EXISTENTE (con una pequeña adición): Preparamos y realizamos la llamada a la API de FaucetPay.
        const FAUCETPAY_SEND_URL = 'https://faucetpay.io/api/v1/send';

        const formData = new URLSearchParams();
        formData.append('api_key', FAUCETPAY_API_KEY);
        formData.append('to', email);
        formData.append('amount', amountInSmallestUnit);
        formData.append('currency', FAUCETPAY_CURRENCY);

        const faucetPayResponse = await fetch(FAUCETPAY_SEND_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: formData,
        });

        const faucetPayData = await faucetPayResponse.json();

        console.log("Respuesta de FaucetPay (envío):", faucetPayData);

        // 8. MODIFICACIÓN CRÍTICA: Procesamos la respuesta de FaucetPay.
        if (faucetPayData.status === 200 && faucetPayData.message === "OK") {
            // El pago a FaucetPay fue exitoso.

            // 8a. NUEVO BLOQUE CRÍTICO: Actualizamos el balance del usuario en Firebase.
            // Calculamos el nuevo balance restando el costo total (monto + comisión).
            const newBalance = currentBalance - totalCostLTC;
            // Actualizamos el campo 'balance' del usuario en Firebase.
            await userRef.update({ balance: newBalance });
            console.log(`Balance de ${userId} actualizado a ${newBalance} LTC después de retiro exitoso.`);

            // 8b. NUEVO BLOQUE CRÍTICO: Registramos la transacción de retiro en Firebase.
            // Esto es crucial para un historial de transacciones y para depuración.
            const transactionsRef = db.ref(`transactions/${userId}`);
            // Usamos .push() para generar una clave única para cada transacción.
            await transactionsRef.push({
                type: 'withdrawal', // Tipo de transacción
                amount: withdrawalAmountLTC, // Monto retirado (sin la comisión)
                fee: WITHDRAWAL_FEE, // Comisión aplicada
                faucetPayEmail: email, // Correo de FaucetPay al que se envió
                timestamp: admin.database.ServerValue.TIMESTAMP, // Timestamp del servidor de Firebase para precisión
                status: 'completed', // Estado de la transacción
                faucetPayTxId: faucetPayData.payout_id || 'N/A', // ID de la transacción de FaucetPay (si está disponible)
                faucetPayBalanceAfter: faucetPayData.balance // Balance de TU cuenta de FaucetPay después del retiro.
            });
            console.log(`Transacción de retiro registrada para ${userId}.`);

            // Respondemos al frontend indicando que el retiro fue exitoso.
            res.json({
                success: true,
                message: 'Retiro procesado con éxito.',
                payout_id: faucetPayData.payout_id, // ID del pago de FaucetPay
                // 9. MODIFICADO: Devolvemos el nuevo balance del usuario de tu DB, no el balance de FaucetPay.
                balance: newBalance
            });
        } else {
            // Si FaucetPay no devuelve un 200 OK, significa que el pago falló.
            // En este caso, NO descontamos el balance del usuario en nuestra DB.
            console.error(`Fallo de FaucetPay para ${userId}:`, faucetPayData.message || 'Error desconocido');
            // Devolvemos un error al frontend.
            res.status(400).json({
                success: false,
                message: faucetPayData.message || 'Error al procesar el retiro con FaucetPay.'
            });
        }

    } catch (error) {
        // Capturamos cualquier error que ocurra durante el proceso (red, Firebase, etc.).
        console.error(`Error interno del servidor al procesar el retiro para ${userId}:`, error);
        res.status(500).json({ success: false, message: 'Error interno del servidor al procesar el retiro.' });
    }
});

// --- NUEVO/MODIFICADO: ENDPOINT: /api/apply-referral-code ---
// Este endpoint es llamado cuando un usuario intenta aplicar un código de referido manualmente.
app.post('/api/apply-referral-code', async (req, res) => {
    const { referralCode, userId } = req.body;

    console.log("Petición recibida en /api/apply-referral-code");
    console.log("Contenido del cuerpo del requisito:", req.body); // Updated log for clarity

    if (!referralCode || !userId) {
        console.error('Error: Faltan parámetros en la petición /api/apply-referral-code.');
        return res.status(400).json({ success: false, message: 'Código de referido y ID de usuario son requeridos.' });
    }

    try {
        // 1. Obtener los datos del usuario que intenta aplicar el código (el "referido")
        const referredUserRef = db.ref('users').child(userId);
        const referredUserSnapshot = await referredUserRef.once('value');
        const referredUserData = referredUserSnapshot.val();

        if (!referredUserData) {
            console.error(`Error: Usuario referido no encontrado para UID: ${userId}`);
            return res.status(404).json({ success: false, message: 'Usuario actual no encontrado.' });
        }

        // Validación: El usuario ya ha sido referido o ya ha reclamado una recompensa de referido.
        if (referredUserData.referredByCode || referredUserData.referralClaimed) {
            console.warn(`Usuario ${userId} ya ha sido referido o ya reclamó recompensa.`);
            return res.status(400).json({ success: false, message: 'Ya has utilizado un código de referido o ya reclamaste la recompensa.' });
        }
        
        // 2. Buscar al usuario referente (el que posee el código de referido)
        const referrerSnapshot = await db.ref('users')
            .orderByChild('referralCode')
            .equalTo(referralCode)
            .limitToFirst(1)
            .once('value');

        if (!referrerSnapshot.exists()) {
            console.warn(`Intento de referido con código no válido: ${referralCode}`);
            return res.status(400).json({ success: false, message: 'Código de referido no válido.' });
        }

        const referrerUid = Object.keys(referrerSnapshot.val())[0];
        const referrerData = referrerSnapshot.val()[referrerUid]; // Datos del usuario referente

        // Validación: Prevenir auto-referido
        if (userId === referrerUid) {
            console.warn(`Intento de auto-referido por UID: ${userId}`);
            return res.status(400).json({ success: false, message: 'No puedes referirte a ti mismo.' });
        }

        // A PARTIR DE AQUÍ CAMBIAMOS LA LÓGICA DE ACTUALIZACIÓN
        // Ya que las lecturas previas funcionan, podemos confiar en obtener los datos de esta manera.
        // Ahora, preparamos un objeto para una actualización multi-ruta atómica.

        // Obtenemos los balances actuales (ya leídos arriba, pero para claridad)
        const referredUserCurrentBalance = referredUserData.balance || 0;
        const referrerCurrentBalance = referrerData.balance || 0;

        // Calculamos los nuevos balances y el contador de referidos
        const newReferredUserBalance = referredUserCurrentBalance + REFERRED_USER_REWARD_AMOUNT;
        const newReferrerBalance = referrerCurrentBalance + REFERRER_REWARD_AMOUNT;
        const newReferrerReferredUsersCount = (referrerData.referredUsersCount || 0) + 1;

        // Preparamos el objeto de actualización multi-ruta
        const updates = {};

        // Actualizaciones para el usuario referido
        updates[`users/${userId}/balance`] = newReferredUserBalance;
        updates[`users/${userId}/referredByCode`] = referralCode;
        updates[`users/${userId}/referralClaimed`] = true;
        updates[`users/${userId}/lastSaveTime`] = admin.database.ServerValue.TIMESTAMP;

        // Actualizaciones para el usuario referente
        updates[`users/${referrerUid}/balance`] = newReferrerBalance;
        updates[`users/${referrerUid}/referredUsersCount`] = newReferrerReferredUsersCount;
        updates[`users/${referrerUid}/lastSaveTime`] = admin.database.ServerValue.TIMESTAMP;

        // Registro del evento de referido en la colección 'referrals'
        // Firebase creará el nodo 'referrals' y sus hijos si no existen.
        updates[`referrals/${referrerUid}/${userId}`] = {
            referredUserUid: userId,
            rewardAmountReferrer: REFERRER_REWARD_AMOUNT,
            rewardAmountReferred: REFERRED_USER_REWARD_AMOUNT,
            timestamp: admin.database.ServerValue.TIMESTAMP
        };

        // Ejecutar la actualización multi-ruta atómicamente
        await db.ref('/').update(updates);
        console.log(`Recompensas aplicadas y datos registrados para ${userId} y ${referrerUid} usando actualización multi-ruta.`);

        // Enviar respuesta de éxito al cliente
        res.json({ success: true, message: 'Recompensa de referido aplicada con éxito.' });

    } catch (error) {
        console.error('Error en el backend al aplicar referido:', error);
        if (error.code === 'PERMISSION_DENIED') {
            res.status(403).json({ success: false, message: 'Error de permisos de Firebase. Verifique su Service Account Key o reglas de seguridad.' });
        } else {
            // Un error inesperado (ej. de red, o un problema con los datos de Firebase)
            res.status(500).json({ success: false, message: 'Error interno del servidor al aplicar el código de referido.' });
        }
    }
});
// --- FIN NUEVO: ENDPOINT: /api/apply-referral ---


// Inicia el servidor Express
app.listen(PORT, () => {
    console.log(`Backend de FaucetPay y Referidos escuchando en el puerto ${PORT}`);
    if (FAUCETPAY_API_KEY) {
        console.log(`FAUCETPAY_API_KEY cargada correctamente (longitud: ${FAUCETPAY_API_KEY.length > 5 ? FAUCETPAY_API_KEY.substring(0, 5) + '...' : 'N/A'})`);
    } else {
        console.log('FAUCETPAY_API_KEY no cargada.');
    }
});
