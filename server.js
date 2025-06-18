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

// === CONSTANTES EN EL BACKEND (MANTENER SINCRONIZADAS) ===
// Asegúrate de que estas constantes estén al principio de tu server.js
const LTC_TO_LITOSHIS_FACTOR = 100_000_000;
// Comision de retiro
const WITHDRAWAL_FEE_LITOSHIS = 1000; // 0.00001 LTC
const MIN_WITHDRAWAL_LITOSHIS_BACKEND = 10000; // 0.0001 LTC
const REFERRED_USER_REWARD_AMOUNT_LITOSHIS = 200; // 0.00002 LTC en Litoshis
const REFERRER_REWARD_AMOUNT_LITOSHIS = 200;    // 0.00002 LTC en Litoshis






// Configuración de middlewares
app.use(express.json()); // Middleware para parsear bodies de solicitud JSON
// app.use(cors());


const authenticate = async (req, res, next) => {
    const idToken = req.headers.authorization ? req.headers.authorization.split('Bearer ')[1] : null;

    if (!idToken) {
        return res.status(401).json({ success: false, message: 'No autorizado: No se proporcionó token.' });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken; // Agrega los datos del usuario autenticado a la solicitud
        next(); // Continúa con la siguiente función de middleware/ruta
    } catch (error) {
        console.error('Error al verificar el token de autenticación:', error);
        return res.status(403).json({ success: false, message: 'No autorizado: Token inválido o expirado.' });
    }
};

app.use(cors({
    origin: ['http://127.0.0.1:3000', 'http://localhost:3000', 'https://tu-dominio-frontend-en-render.onrender.com'], 
    methods: ['GET', 'POST', 'OPTIONS'], // <--- ¡Asegúrate de que 'OPTIONS' esté aquí!
    allowedHeaders: ['Content-Type', 'Authorization'], 
    credentials: true 
}));






// --- ENDPOINT PARA VALIDAR EL CORREO ELECTRÓNICO CON FAUCETPAY ---
// Aplica el middleware 'authenticate' a esta ruta
app.post('/api/validate-faucetpay-email', authenticate, async (req, res) => {
    const { email } = req.body;
    // req.user ahora contiene el UID del usuario, puedes usarlo para auditoría si es necesario
    const userId = req.user.uid; 
    console.log(`Validando FaucetPay email para ${userId}: ${email}`);

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
            // Si FaucetPay valida el correo, puedes opcionalmente guardarlo aquí en tu DB
            // db.ref(`users/${userId}`).update({ faucetPayEmail: email });
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
// Aplica el middleware 'authenticate' a esta ruta
app.post('/api/request-faucetpay-withdrawal', authenticate, async (req, res) => {
    // El userId ahora viene del token autenticado, no del body (más seguro)
    const userId = req.user.uid;
    const { email, amount } = req.body; // 'email' debería ser el email de FaucetPay que el usuario tiene guardado en tu DB
                                        // 'amount' es el monto en LTC (decimal) desde el frontend

    if (!email || !amount) {
        return res.status(400).json({ success: false, message: 'Email/dirección y monto son requeridos para el retiro.' });
    }

    const withdrawalAmountLTC = parseFloat(amount);
    if (isNaN(withdrawalAmountLTC) || withdrawalAmountLTC <= 0) {
        return res.status(400).json({ success: false, message: 'Monto de retiro inválido.' });
    }
    const withdrawalAmountLitoshis = Math.round(withdrawalAmountLTC * LTC_TO_LITOSHIS_FACTOR);

    // Usa la constante de comisión definida globalmente
    const WITHDRAWAL_FEE_LITOSHIS = 1000; // Esto representa 0.00001000 LTC - ASEGÚRATE DE QUE ESTA CONSTANTE TAMBIÉN ESTÉ EN EL TOP DEL server.js
    const MIN_WITHDRAWAL_LITOSHIS_BACKEND = 100000; // 0.001 LTC. Defínelo también al inicio de server.js

    // Validar monto mínimo en el backend también
    if (withdrawalAmountLitoshis < MIN_WITHDRAWAL_LITOSHIS_BACKEND) {
        return res.status(400).json({ success: false, message: `La cantidad mínima de retiro es ${ (MIN_WITHDRAWAL_LITOSHIS_BACKEND / LTC_TO_LITOSHIS_FACTOR).toFixed(8) } LTC.` });
    }


    const totalCostLitoshis = withdrawalAmountLitoshis + WITHDRAWAL_FEE_LITOSHIS;

    const userRef = db.ref(`users/${userId}`);

    // Usar una transacción para asegurar la integridad del balance
    const transactionResult = await userRef.transaction(currentData => {
        if (currentData) {
            const currentBalanceLitoshis = currentData.balance || 0;
            const storedFaucetPayEmail = currentData.faucetPayEmail;

            // Vuelve a verificar que el email enviado por el cliente coincide con el guardado
            if (storedFaucetPayEmail !== email) {
                console.warn(`Discrepancia de email FaucetPay para ${userId}: Cliente envió '${email}', DB tiene '${storedFaucetPayEmail}'.`);
                // Podrías devolver undefined para abortar la transacción o manejarlo como error
                return; // Aborta la transacción
            }

            if (currentBalanceLitoshis >= totalCostLitoshis) {
                currentData.balance = currentBalanceLitoshis - totalCostLitoshis;
                return currentData; // Retorna el nuevo estado para que Firebase lo actualice
            } else {
                console.warn(`Balance insuficiente para ${userId}: ${currentBalanceLitoshis} < ${totalCostLitoshis}`);
                // Podrías devolver undefined o lanzar un error específico si transaction soporta eso directamente
            }
        }
        return; // Aborta la transacción si no hay datos o balance insuficiente
    });

    if (transactionResult.committed && transactionResult.snapshot.val()) {
        const newBalanceLitoshis = transactionResult.snapshot.val().balance;

        // Balance deducido, ahora procede con FaucetPay
        const FAUCETPAY_SEND_URL = 'https://faucetpay.io/api/v1/send';
        const formData = new URLSearchParams();
        formData.append('api_key', FAUCETPAY_API_KEY);
        formData.append('to', email);
        formData.append('amount', withdrawalAmountLitoshis);
        formData.append('currency', FAUCETPAY_CURRENCY);

        const faucetPayResponse = await fetch(FAUCETPAY_SEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData,
        });
        const faucetPayData = await faucetPayResponse.json();

        console.log("Respuesta de FaucetPay (envío):", faucetPayData);

        if (faucetPayData.status === 200 && faucetPayData.message === "OK") {
            // Pago exitoso en FaucetPay
            db.ref(`transactions/${userId}`).push({
                type: 'withdrawal',
                amount: withdrawalAmountLitoshis,
                fee: WITHDRAWAL_FEE_LITOSHIS,
                faucetPayEmail: email,
                timestamp: admin.database.ServerValue.TIMESTAMP,
                status: 'completed',
                faucetPayTxId: faucetPayData.payout_id || 'N/A',
            });
            console.log(`Transacción de retiro registrada para ${userId}.`);

            res.json({
                success: true,
                message: 'Retiro procesado con éxito.',
                payout_id: faucetPayData.payout_id,
                balance: newBalanceLitoshis
            });
        } else {
            // Si FaucetPay falla, debemos REVERTIR el balance en Firebase
            console.error(`Fallo de FaucetPay para ${userId}. Revirtiendo balance. Mensaje FaucetPay: ${faucetPayData.message || 'Desconocido'}`);
            // REVERSIÓN DEL BALANCE: Incrementar el balance del usuario nuevamente
            await userRef.transaction(currentData => {
                if (currentData) {
                    currentData.balance = (currentData.balance || 0) + totalCostLitoshis;
                    console.log(`Balance de ${userId} revertido a ${currentData.balance} Litoshis.`);
                    return currentData;
                }
                return; // Abortar si no hay datos (no debería pasar)
            });

            // Opcional: registrar el intento fallido de retiro
            db.ref(`transactions/${userId}`).push({
                type: 'withdrawal_failed',
                amount: withdrawalAmountLitoshis,
                fee: WITHDRAWAL_FEE_LITOSHIS,
                faucetPayEmail: email,
                timestamp: admin.database.ServerValue.TIMESTAMP,
                status: 'failed',
                errorMessage: faucetPayData.message || 'Error desconocido de FaucetPay.',
            });

            res.status(400).json({
                success: false,
                message: faucetPayData.message || 'Error al procesar el retiro con FaucetPay. Fondos devueltos a tu balance.'
            });
        }
    } else if (transactionResult.aborted) {
        // La transacción fue abortada (ej. balance insuficiente, email no coincide)
        if (transactionResult.snapshot && transactionResult.snapshot.val().faucetPayEmail !== email) {
            return res.status(400).json({ success: false, message: 'El correo de FaucetPay en tu cuenta no coincide con el de la solicitud.' });
        }
        return res.status(400).json({ success: false, message: 'Balance insuficiente para el retiro o error interno de la base de datos.' });
    } else {
        // Esto puede ocurrir si el usuario no existe, o algún otro problema con la transacción
        return res.status(500).json({ success: false, message: 'No se pudo procesar el retiro debido a un problema de la base de datos.' });
    }

});

// --- ENDPOINT PARA APLICAR CÓDIGO DE REFERIDO (CON AUTENTICACIÓN) ---
app.post('/api/apply-referral-code', authenticate, async (req, res) => {
    // El userId ahora viene del token autenticado, no del body
    const userId = req.user.uid;
    const { referralCode } = req.body;

    if (!referralCode) {
        return res.status(400).json({ success: false, message: 'Código de referido es requerido.' });
    }

    try {
        const referredUserRef = db.ref('users').child(userId);
        const referredUserSnapshot = await referredUserRef.once('value');
        const referredUserData = referredUserSnapshot.val();

        if (!referredUserData) {
            console.error(`Error: Usuario referido no encontrado para UID: ${userId}`);
            return res.status(404).json({ success: false, message: 'Usuario actual no encontrado.' });
        }

        if (referredUserData.referredByCode || referredUserData.referralClaimed) {
            console.log(`[REFERRAL_ENDPOINT] Ya ha utilizado código: ${userId}`);
            return res.status(400).json({ success: false, message: 'Ya has utilizado un código de referido o ya reclamaste la recompensa.' });
        }

        const referrerSnapshot = await db.ref('users')
            .orderByChild('referralCode')
            .equalTo(referralCode)
            .limitToFirst(1)
            .once('value');

        if (!referrerSnapshot.exists()) {
            return res.status(400).json({ success: false, message: 'Código de referido no válido.' });
        }

        const referrerUid = Object.keys(referrerSnapshot.val())[0];
        const referrerData = referrerSnapshot.val()[referrerUid];

        if (userId === referrerUid) {
            return res.status(400).json({ success: false, message: 'No puedes referirte a ti mismo.' });
        }

        // --- Aplicar recompensas y actualizar base de datos con transacción ---
        // Usamos una transacción para el usuario referido para asegurar la atomicidad
        const referredUserTransactionResult = await referredUserRef.transaction(currentReferredUserData => {
            if (currentReferredUserData) {
                if (currentReferredUserData.referredByCode || currentReferredUserData.referralClaimed) {
                    // Si ya se aplicó en el interín, abortar.
                    return;
                }
                currentReferredUserData.balance = (currentReferredUserData.balance || 0) + REFERRED_USER_REWARD_AMOUNT_LITOSHIS;
                currentReferredUserData.referredByCode = referralCode;
                currentReferredUserData.referralClaimed = true;
                currentReferredUserData.referralRewardAmount = REFERRED_USER_REWARD_AMOUNT_LITOSHIS;
                return currentReferredUserData;
            }
            return; // Abortar si no hay datos
        });

        if (!referredUserTransactionResult.committed) {
            console.error(`Transacción de referido abortada para ${userId}.`);
            return res.status(500).json({ success: false, message: 'Error al aplicar la recompensa de referido (transacción fallida).' });
        }

        // Actualizar balance del referente y contador (no necesitamos transacción aquí si solo es un incremento simple)
        const referrerRef = db.ref(`users/${referrerUid}`);
        await referrerRef.update({
            balance: (referrerData.balance || 0) + REFERRER_REWARD_AMOUNT_LITOSHIS,
            referralsCount: admin.database.ServerValue.increment(1)
        });

        console.log(`[REFERRAL_ENDPOINT] Recompensa aplicada para ${userId} (referido) y ${referrerUid} (referente).`);

        return res.status(200).json({
            success: true,
            message: '¡Código de referido aplicado con éxito! Has ganado Litoshis.',
            referredByCode: referralCode,
            referralRewardAmount: REFERRED_USER_REWARD_AMOUNT_LITOSHIS
        });

    } catch (error) {
        console.error("Error al aplicar código de referido:", error);
        return res.status(500).json({ success: false, message: 'Error interno del servidor al aplicar el código de referido.' });
    }
});



// Inicia el servidor Express
app.listen(PORT, () => {
    console.log(`Backend de FaucetPay y Referidos escuchando en el puerto ${PORT}`);
    if (FAUCETPAY_API_KEY) {
        console.log(`FAUCETPAY_API_KEY cargada correctamente (longitud: ${FAUCETPAY_API_KEY.length > 5 ? FAUCETPAY_API_KEY.substring(0, 5) + '...' : 'N/A'})`);
    } else {
        console.log('FAUCETPAY_API_KEY no cargada.');
    }
});
