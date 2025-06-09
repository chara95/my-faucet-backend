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

// --- Recupera tu API Key de FaucetPay de las variables de entorno ---
const FAUCETPAY_API_KEY = process.env.FAUCETPAY_API_KEY;

// Asegúrate de que la API Key esté configurada
if (!FAUCETPAY_API_KEY || FAUCETPAY_API_KEY === 'TU_API_KEY_REAL_DE_FAUCETPAY_AQUI') {
    console.error('ERROR: FAUCETPAY_API_KEY no está configurada en el archivo .env o es el valor por defecto.');
    console.error('Por favor, reemplaza "TU_API_KEY_REAL_DE_FAUCETPAY_AQUI" en .env con tu clave real.');
    process.exit(1); // Sale de la aplicación si la clave no está configurada
}

const FAUCETPAY_CURRENCY = 'LTC'; // La moneda que vas a usar para validación/pagos

// --- NUEVO: CONFIGURACIÓN DE FIREBASE ADMIN SDK ---
// ¡IMPORTANTE! Es altamente recomendado usar variables de entorno para las credenciales en producción (Render).
// Para obtener estas credenciales, descarga tu Service Account Key JSON de Firebase:
// Configuración del proyecto -> Cuentas de servicio -> Generar nueva clave privada.
// Luego, copia las propiedades de ese JSON a variables de entorno en Render.
const serviceAccount = {
  "type": process.env.FIREBASE_TYPE,
  "project_id": process.env.FIREBASE_PROJECT_ID,
  "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
  // La clave privada viene con \n, asegúrate de que Render la lea correctamente.
  // Podrías necesitar reemplazar \\n por \n si la variable de entorno lo codifica.
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

// Configuración de middlewares
app.use(express.json()); // Middleware para parsear bodies de solicitud JSON
app.use(cors());

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
    const { email, amount } = req.body;

    if (!email || !amount) {
        return res.status(400).json({ success: false, message: 'Email/dirección y monto son requeridos para el retiro.' });
    }

    let amountInSmallestUnit;
    if (FAUCETPAY_CURRENCY === 'LTC') {
        amountInSmallestUnit = Math.round(parseFloat(amount) * 100_000_000);
    } else if (FAUCETPAY_CURRENCY === 'BTC') {
        amountInSmallestUnit = Math.round(parseFloat(amount) * 100_000_000);
    } else {
        return res.status(400).json({ success: false, message: 'Moneda no soportada para el retiro.' });
    }

    try {
        const FAUCETPAY_SEND_URL = 'https://faucetpay.io/api/v1/send';

        const formData = new URLSearchParams();
        formData.append('api_key', FAUCETPAY_API_KEY);
        formData.append('to', email);
        formData.append('amount', amountInSmallestUnit);
        formData.append('currency', FAUCETPAY_CURRENCY);

        const response = await fetch(FAUCETPAY_SEND_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: formData,
        });

        const faucetPayData = await response.json();

        console.log("Respuesta de FaucetPay (envío):", faucetPayData);

        if (faucetPayData.status === 200 && faucetPayData.message === "OK") {
            res.json({
                success: true,
                message: 'Retiro procesado con éxito.',
                payout_id: faucetPayData.payout_id,
                balance: faucetPayData.balance
            });
        } else {
            console.error('Error de FaucetPay al procesar retiro:', faucetPayData.message || 'Error desconocido');
            res.status(400).json({
                success: false,
                message: faucetPayData.message || 'Error al procesar el retiro.'
            });
        }

    } catch (error) {
        console.error('Error interno del servidor al procesar el retiro:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor al procesar el retiro.' });
    }
});


// --- NUEVO: ENDPOINT: /api/apply-referral ---
// Este endpoint es llamado por tu aplicación móvil cuando un usuario intenta aplicar un código de referido.
app.post('/api/apply-referral', async (req, res) => {
    const { referrerCode, referredUserUid, referralRewardAmount, source } = req.body;

    // 1. Validación inicial de los datos recibidos
    if (!referrerCode || !referredUserUid || referralRewardAmount === undefined) {
        console.error('Error: Faltan parámetros en la petición /api/apply-referral.');
        return res.status(400).json({ success: false, message: 'Parámetros incompletos.' });
    }

    try {
        // 2. Buscar al usuario referente (el que dio el código)
        const referrerSnapshot = await db.ref('users')
            .orderByChild('referralCode')
            .equalTo(referrerCode)
            .limitToFirst(1)
            .once('value');

        if (!referrerSnapshot.exists()) {
            console.warn(`Intento de referido con código no válido: ${referrerCode}`);
            return res.status(400).json({ success: false, message: 'Código de referido no válido.' });
        }

        const referrerUid = Object.keys(referrerSnapshot.val())[0];

        // 3. Verificar al usuario referido (el que usó el código)
        const referredUserRef = db.ref('users').child(referredUserUid);
        const referredUserSnapshot = await referredUserRef.once('value');
        const referredUserData = referredUserSnapshot.val();

        if (!referredUserData) {
            console.error(`Error: Usuario referido no encontrado para UID: ${referredUserUid}`);
            return res.status(404).json({ success: false, message: 'Usuario referido no encontrado.' });
        }

        // Prevenir auto-referido
        if (referredUserUid === referrerUid) {
            console.warn(`Intento de auto-referido por UID: ${referredUserUid}`);
            return res.status(400).json({ success: false, message: 'No puedes referirte a ti mismo.' });
        }

        // Prevenir que un usuario sea referido múltiples veces
        if (referredUserData.referredByCode || referredUserData.referralClaimed) {
            console.warn(`Usuario ${referredUserUid} ya ha sido referido o reclamó recompensa.`);
            return res.status(400).json({ success: false, message: 'Ya has utilizado un código de referido o ya reclamaste la recompensa.' });
        }

        // 4. Aplicar las recompensas usando una transacción para asegurar la atomicidad
        await db.ref('/').transaction(currentData => {
            if (currentData) {
                // Asegurarse de que las estructuras existen antes de intentar acceder a ellas
                if (!currentData.users) {
                    currentData.users = {};
                }
                if (!currentData.referrals) {
                    currentData.referrals = {};
                }

                // --- Actualizar el usuario referido ---
                if (currentData.users[referredUserUid]) {
                    currentData.users[referredUserUid].balance = (currentData.users[referredUserUid].balance || 0) + referralRewardAmount;
                    currentData.users[referredUserUid].referredByCode = referrerCode;
                    currentData.users[referredUserUid].referralClaimed = true;
                    currentData.users[referredUserUid].lastSaveTime = admin.database.ServerValue.TIMESTAMP;
                    console.log(`Usuario referido ${referredUserUid} recompensado con ${referralRewardAmount}.`);
                } else {
                    console.error(`Error en transacción: Usuario referido ${referredUserUid} no encontrado en currentData.`);
                    return;
                }

                // --- Actualizar el usuario referente ---
                if (currentData.users[referrerUid]) {
                    currentData.users[referrerUid].balance = (currentData.users[referrerUid].balance || 0) + referralRewardAmount;
                    currentData.users[referrerUid].referredUsersCount = (currentData.users[referrerUid].referredUsersCount || 0) + 1;
                    currentData.users[referrerUid].lastSaveTime = admin.database.ServerValue.TIMESTAMP;
                    console.log(`Usuario referente ${referrerUid} recompensado con ${referralRewardAmount}.`);
                } else {
                    console.error(`Error en transacción: Usuario referente ${referrerUid} no encontrado en currentData.`);
                    return;
                }

                // --- Registrar el evento de referido en la colección 'referrals' ---
                if (!currentData.referrals[referrerUid]) {
                    currentData.referrals[referrerUid] = {};
                }
                currentData.referrals[referrerUid][referredUserUid] = {
                    referredUserUid: referredUserUid,
                    referredUserCode: referredUserData.referralCode,
                    rewardAmount: referralRewardAmount,
                    source: source,
                    timestamp: admin.database.ServerValue.TIMESTAMP
                };
                console.log(`Evento de referido registrado para ${referrerUid} y ${referredUserUid}.`);
            }
            return currentData;
        });

        // 5. Enviar respuesta de éxito al cliente
        res.json({ success: true, message: 'Recompensa de referido aplicada con éxito.' });

    } catch (error) {
        console.error('Error en el backend al aplicar referido:', error);
        if (error.code === 'PERMISSION_DENIED') {
            res.status(403).json({ success: false, message: 'Error de permisos de Firebase. Verifique su Service Account Key o reglas.' });
        } else if (error.code === 'transaction failed') {
            res.status(500).json({ success: false, message: 'Fallo la transacción de la base de datos.' });
        } else {
            res.status(500).json({ success: false, message: 'Error interno del servidor al aplicar referido.' });
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
