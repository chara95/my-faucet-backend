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

const REFERRED_USER_REWARD_AMOUNT_LITOSHIS = 200; // 0.00005 LTC en Litoshis
const REFERRER_REWARD_AMOUNT_LITOSHIS = 200;    // 0.00002 LTC en Litoshis
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
    const { email, amount, userId } = req.body;

    if (!email || !amount || !userId) {
        return res.status(400).json({ success: false, message: 'Email/dirección, monto y ID de usuario son requeridos para el retiro.' });
    }

    // 1. Convertir el monto recibido del frontend (LTC decimal) a Litoshis (entero)
    const withdrawalAmountLTC = parseFloat(amount); // Ejemplo: 0.0002 LTC
    if (isNaN(withdrawalAmountLTC) || withdrawalAmountLTC <= 0) {
        return res.status(400).json({ success: false, message: 'Monto de retiro inválido.' });
    }
    const withdrawalAmountLitoshis = Math.round(withdrawalAmountLTC * 100_000_000); // Ejemplo: 20000 Litoshis

    // 2. Definir la comisión SIEMPRE en Litoshis (entero)
    const WITHDRAWAL_FEE_LITOSHIS = 1000; // Esto representa 0.00001000 LTC

    // 3. Calcular el costo total en Litoshis (entero)
    const totalCostLitoshis = withdrawalAmountLitoshis + WITHDRAWAL_FEE_LITOSHIS;

    // Referencia al nodo del usuario específico en tu base de datos de Firebase.
    const userRef = db.ref(`users/${userId}`);

    try {
        // 4. Obtener el balance actual del usuario de Firebase.
        // ASUMIMOS que el balance en Firebase ya está o se va a migrar a Litoshis (enteros).
        const snapshot = await userRef.once('value');
        const userData = snapshot.val();
        const currentBalanceLitoshis = userData.balance || 0; // Lee el balance como Litoshis

        // 5. Verificar si el balance es suficiente (todos los valores son Litoshis enteros)
        if (currentBalanceLitoshis < totalCostLitoshis) {
            console.warn(`Intento de retiro fallido para ${userId}: balance insuficiente. Solicitado (Litoshis): ${totalCostLitoshis}, Actual (Litoshis): ${currentBalanceLitoshis}`);
            return res.status(400).json({ success: false, message: 'Balance insuficiente para el retiro.' });
        }

        // 6. Preparar y realizar la llamada a la API de FaucetPay.
        // FaucetPay espera montos en su unidad más pequeña (Litoshis/Satoshis).
        const FAUCETPAY_SEND_URL = 'https://faucetpay.io/api/v1/send';

        const formData = new URLSearchParams();
        formData.append('api_key', FAUCETPAY_API_KEY);
        formData.append('to', email);
        formData.append('amount', withdrawalAmountLitoshis); // <-- Enviar Litoshis a FaucetPay (es lo que espera)
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

        // 7. Procesar la respuesta de FaucetPay.
        if (faucetPayData.status === 200 && faucetPayData.message === "OK") {
            // El pago a FaucetPay fue exitoso.

            // 8. Actualizar el balance del usuario en Firebase (en Litoshis enteros)
            const newBalanceLitoshis = currentBalanceLitoshis - totalCostLitoshis; // Cálculos en Litoshis
            await userRef.update({ balance: newBalanceLitoshis }); // Guardar Litoshis en Firebase

            // Log de la actualización del balance
            console.log(`Balance de ${userId} actualizado a ${newBalanceLitoshis} Litoshis después de retiro exitoso.`);

            // 9. Registrar la transacción de retiro en Firebase (manteniendo consistencia)
            const transactionsRef = db.ref(`transactions/${userId}`);
            await transactionsRef.push({
                type: 'withdrawal',
                amount: withdrawalAmountLitoshis, // Registrar en Litoshis
                fee: WITHDRAWAL_FEE_LITOSHIS,     // Registrar en Litoshis
                faucetPayEmail: email,
                timestamp: admin.database.ServerValue.TIMESTAMP,
                status: 'completed',
                faucetPayTxId: faucetPayData.payout_id || 'N/A',
                // Si faucetPayData.balance devuelve LTC decimal, considera no guardarlo o convertirlo
                // faucetPayBalanceAfter: faucetPayData.balance // Esto podría ser decimal de FaucetPay
            });
            console.log(`Transacción de retiro registrada para ${userId}.`);

            // 10. Responder al frontend. Devuelve el nuevo balance en Litoshis enteros.
            res.json({
                success: true,
                message: 'Retiro procesado con éxito.',
                payout_id: faucetPayData.payout_id,
                balance: newBalanceLitoshis // <-- Devuelve el balance en Litoshis enteros
            });
        } else {
            // Si FaucetPay falla, NO descontamos el balance del usuario.
            console.error(`Fallo de FaucetPay para ${userId}:`, faucetPayData.message || 'Error desconocido');
            res.status(400).json({
                success: false,
                message: faucetPayData.message || 'Error al procesar el retiro con FaucetPay.'
            });
        }

    } catch (error) {
        console.error(`Error interno del servidor al procesar el retiro para ${userId}:`, error);
        res.status(500).json({ success: false, message: 'Error interno del servidor al procesar el retiro.' });
    }
});

// Este endpoint es llamado cuando un usuario intenta aplicar un código de referido manualmente.
app.post('/api/apply-referral-code', async (req, res) => {

    console.log('[REFERRAL_ENDPOINT] Iniciando procesamiento de solicitud de referido.');
    const { referralCode, userId } = req.body;
    if (!referralCode || !userId) {
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

        // Validación: El usuario ya ha sido referido o ya ha reclamado una recompensa.
        // Asumiendo que 'referredByCode' y 'referralClaimed' son banderas booleanas.
        if (referredUserData.referredByCode || referredUserData.referralClaimed) {
            console.error(`Ya has utilizado un código de referido o ya reclamaste la recompensa.D: ${userId}`);
            return res.status(400).json({ success: false, message: 'Ya has utilizado un código de referido o ya reclamaste la recompensa.' });
        }

        // 2. Buscar al usuario referente (el que posee el código de referido)
        const referrerSnapshot = await db.ref('users')
            .orderByChild('referralCode')
            .equalTo(referralCode)
            .limitToFirst(1)
            .once('value');

        if (!referrerSnapshot.exists()) {
            console.error(`Código de referido no válido.: ${userId}`);
            return res.status(400).json({ success: false, message: 'Código de referido no válido.' });
        }

        const referrerUid = Object.keys(referrerSnapshot.val())[0];
        const referrerData = referrerSnapshot.val()[referrerUid]; // Datos del usuario referente

        // Validación: Prevenir auto-referido
        if (userId === referrerUid) {
            console.error(`No puedes referirte a ti mismo.: ${userId}`);
            return res.status(400).json({ success: false, message: 'No puedes referirte a ti mismo.' });
        }

        // --- INICIO DE MODIFICACIONES CLAVE ---

        // Obtener los balances actuales de Firebase, ASUMIENDO que ya están en Litoshis enteros
        const referredUserCurrentBalanceLitoshis = referredUserData.balance || 0;
        const referrerCurrentBalanceLitoshis = referrerData.balance || 0;

        // Calcular los nuevos balances sumando las recompensas en Litoshis enteros
        const newReferredUserBalanceLitoshis = referredUserCurrentBalanceLitoshis + REFERRED_USER_REWARD_AMOUNT_LITOSHIS;
        const newReferrerBalanceLitoshis = referrerCurrentBalanceLitoshis + REFERRER_REWARD_AMOUNT_LITOSHIS;

        const newReferrerReferredUsersCount = (referrerData.referredUsersCount || 0) + 1;

        // Preparamos el objeto de actualización multi-ruta
        const updates = {};

        // Actualizaciones para el usuario referido
        updates[`users/${userId}/balance`] = newReferredUserBalanceLitoshis; // Almacenar en Litoshis
        updates[`users/${userId}/referredByCode`] = referralCode;
        updates[`users/${userId}/referralClaimed`] = true;
        updates[`users/${userId}/lastSaveTime`] = admin.database.ServerValue.TIMESTAMP;

        // Actualizaciones para el usuario referente
        updates[`users/${referrerUid}/balance`] = newReferrerBalanceLitoshis; // Almacenar en Litoshis
        updates[`users/${referrerUid}/referredUsersCount`] = newReferrerReferredUsersCount;
        updates[`users/${referrerUid}/lastSaveTime`] = admin.database.ServerValue.TIMESTAMP;

        // Registro del evento de referido en la colección 'referrals'
        updates[`referrals/${referrerUid}/${userId}`] = {
            referredUserUid: userId,
            // Registrar las recompensas en Litoshis para la consistencia del historial
            rewardAmountReferrer: REFERRER_REWARD_AMOUNT_LITOSHIS,
            rewardAmountReferred: REFERRED_USER_REWARD_AMOUNT_LITOSHIS,
            timestamp: admin.database.ServerValue.TIMESTAMP
        };

        // --- FIN DE MODIFICACIONES CLAVE ---

        // Ejecutar la actualización multi-ruta atómicamente
        await db.ref('/').update(updates);
        console.log(`Recompensas de referido aplicadas y datos registrados para ${userId} y ${referrerUid}.`);

        // Enviar respuesta de éxito al cliente
        res.json({ success: true, message: 'Recompensa de referido aplicada con éxito.' });

    } catch (error) {
        if (error.code === 'PERMISSION_DENIED') {
            res.status(403).json({ success: false, message: 'Error de permisos de Firebase. Verifique su Service Account Key o reglas de seguridad.' });
        } else {
            console.error('Error interno del servidor al aplicar el código de referido:', error); // Log más detallado
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
