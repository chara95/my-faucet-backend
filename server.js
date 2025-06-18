// server.js
// Backend completo en Node.js con Express, Firebase Admin SDK y FaucetPay.

// Carga las variables de entorno desde el archivo .env
import 'dotenv/config';

import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import admin from 'firebase-admin';

const app = express();
const PORT = process.env.PORT || 3001;
const FAUCETPAY_API_KEY = process.env.FAUCETPAY_API_KEY;
const FAUCETPAY_CURRENCY = 'LTC';

// Asegúrate de que la API Key esté configurada
if (!FAUCETPAY_API_KEY || FAUCETPAY_API_KEY === 'TU_API_KEY_REAL_DE_FAUCETPAY_AQUI') {
    console.error('ERROR: FAUCETPAY_API_KEY no está configurada en el archivo .env o es el valor por defecto.');
    console.error('Por favor, reemplaza "TU_API_KEY_REAL_DE_FAUCETPAY_AQUI" en .env con tu clave real.');
    process.exit(1);
}

// --- CONFIGURACIÓN DE FIREBASE ADMIN SDK ---

// Construye el objeto serviceAccount a partir de variables de entorno individuales
// La clave privada necesita el reemplazo de '\n' si viene escapada en la variable de entorno
const serviceAccount = {
    "type": process.env.FIREBASE_TYPE,
    "project_id": process.env.FIREBASE_PROJECT_ID,
    "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
    // Asegúrate de que la clave privada se maneje correctamente.
    // Si la variable de entorno ya contiene los saltos de línea literales, el replace no es necesario.
    // Si contiene "\\n" escapados, el replace los convierte a "\n" reales.
    "private_key": process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    "client_email": process.env.FIREBASE_CLIENT_EMAIL,
    "client_id": process.env.FIREBASE_CLIENT_ID,
    "auth_uri": process.env.FIREBASE_AUTH_URI,
    "token_uri": process.env.FIREBASE_TOKEN_URI,
    "auth_provider_x509_cert_url": process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    "client_x509_cert_url": process.env.FIREBASE_CLIENT_X509_CERT_URL,
    "universe_domain": process.env.FIREBASE_UNIVERSE_DOMAIN
};

// Verifica si las credenciales de Firebase están disponibles y son válidas antes de inicializar
if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    console.error('ERROR: Algunas variables de entorno de Firebase Admin SDK no están configuradas correctamente.');
    console.error('Por favor, asegúrate de que FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL, etc., estén definidas en tus variables de entorno de Render.');
    // Es CRÍTICO que estas credenciales estén bien para que Firebase Admin SDK funcione.
    // Si no están, las operaciones de Firebase fallarán. Podrías considerar un process.exit(1) aquí.
    process.exit(1); // Terminamos el proceso si las credenciales básicas no están.
}

try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL // Usa una variable de entorno para la URL de la base de datos
    });
    console.log("Firebase Admin SDK inicializado correctamente.");
} catch (error) {
    console.error("ERROR: No se pudo inicializar Firebase Admin SDK:", error.message);
    process.exit(1); // Si el SDK no se inicializa, el backend no puede funcionar correctamente
}

// Obtiene una referencia a la Realtime Database
const db = admin.database();
console.log("Firebase Admin SDK: Conectado a DB:", admin.app().options.databaseURL);
// --- FIN CONFIGURACIÓN DE FIREBASE ADMIN SDK ---

// === CONSTANTES EN EL BACKEND (MANTENER SINCRONIZADAS) ===
const LTC_TO_LITOSHIS_FACTOR = 100_000_000;
const WITHDRAWAL_FEE_LITOSHIS = 1000; // 0.00001 LTC
const MIN_WITHDRAWAL_LITOSHIS_BACKEND = 1000; // 0.00001 LTC
const REFERRED_USER_REWARD_AMOUNT_LITOSHIS = 200; // 0.00002 LTC en Litoshis
const REFERRER_REWARD_AMOUNT_LITOSHIS = 200; // 0.00002 LTC en Litoshis

// Configuración de middlewares
app.use(express.json()); // Middleware para parsear bodies de solicitud JSON

// Configuración de CORS
app.use(cors({
    origin: ['http://127.0.0.1:3000', 'http://localhost:3000', 'https://my-faucet-backend-3.onrender.com'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Middleware de autenticación
const authenticate = async (req, res, next) => {
    const idToken = req.headers.authorization ? req.headers.authorization.split('Bearer ')[1] : null;

    if (!idToken) {
        return res.status(401).json({ success: false, message: 'No autorizado: No se proporcionó token.' });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken; // Agrega los datos del usuario autenticado a la solicitud
        next();
    } catch (error) {
        console.error('Error al verificar el token de autenticación:', error);
        return res.status(403).json({ success: false, message: 'No autorizado: Token inválido o expirado.' });
    }
};

// --- ENDPOINT PARA VALIDAR EL CORREO ELECTRÓNICO CON FAUCETPAY ---
app.post('/api/validate-faucetpay-email', authenticate, async (req, res) => {
    const { email } = req.body;
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

        console.log("Respuesta de FaucetPay (validación):", faucetPayData);

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
        } else {
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
    console.log('¡Solicitud de retiro recibida!');

    const userId = req.user.uid;
    const { email, amount } = req.body;

    if (!email || !amount) {
        return res.status(400).json({ success: false, message: 'Email/dirección y monto son requeridos para el retiro.' });
    }

    const withdrawalAmountLTC = parseFloat(amount);
    if (isNaN(withdrawalAmountLTC) || withdrawalAmountLTC <= 0) {
        return res.status(400).json({ success: false, message: 'Monto de retiro inválido.' });
    }
    const withdrawalAmountLitoshis = Math.round(withdrawalAmountLTC * LTC_TO_LITOSHIS_FACTOR);

    // Validar monto mínimo en el backend también
    if (withdrawalAmountLitoshis < MIN_WITHDRAWAL_LITOSHIS_BACKEND) {
        return res.status(400).json({ success: false, message: `La cantidad mínima de retiro es ${(MIN_WITHDRAWAL_LITOSHIS_BACKEND / LTC_TO_LITOSHIS_FACTOR).toFixed(8)} LTC.` });
    }

    const totalCostLitoshis = withdrawalAmountLitoshis + WITHDRAWAL_FEE_LITOSHIS;

    const userRef = db.ref(`users/${userId}`);

    // --- PRUEBA DE LECTURA DIRECTA ANTES DE LA TRANSACCIÓN ---
    try {
        const snapshot = await userRef.once('value');
        if (snapshot.exists()) {
            const userData = snapshot.val();
            console.log("TEST_LECTURA_DIRECTA: Datos del usuario encontrados:", userData); // Log de datos encontrados
            if (userData.balance === undefined || userData.faucetPayEmail === undefined) {
                console.warn("TEST_LECTURA_DIRECTA: El usuario existe pero le faltan campos clave (balance/faucetPayEmail).");
            }
        } else {
            console.error("TEST_LECTURA_DIRECTA: El snapshot no existe. NO SE ENCONTRARON DATOS DEL USUARIO POR LECTURA DIRECTA.");
        }
    } catch (readError) {
        console.error("TEST_LECTURA_DIRECTA: Error al intentar leer directamente los datos del usuario:", readError);
    }
    // --- FIN PRUEBA DE LECTURA DIRECTA ---

    // Usar una transacción para asegurar la integridad del balance
    console.log("La transacción intenta acceder a:", userRef.toString()); // Log de la ruta a la que se intenta acceder
    const transactionResult = await userRef.transaction(currentData => {
        console.log("Transacción - currentData dentro del callback:", currentData); // Log dentro del callback de la transacción

        try { // <--- AÑADIDO: Bloque try para capturar errores dentro del callback
            if (currentData) {
                const currentBalanceLitoshis = currentData.balance || 0;
                const storedFaucetPayEmail = currentData.faucetPayEmail;

                // Debug logs dentro de la transacción
                console.log("Transacción - currentBalanceLitoshis:", currentBalanceLitoshis);
                console.log("Transacción - storedFaucetPayEmail:", storedFaucetPayEmail);
                console.log("Transacción - email de solicitud:", email);
                console.log("Transacción - totalCostLitoshis:", totalCostLitoshis);

                if (storedFaucetPayEmail !== email) {
                    console.warn(`Discrepancia de email FaucetPay para ${userId}: Cliente envió '${email}', DB tiene '${storedFaucetPayEmail}'. ABORTANDO.`);
                    return; // Aborta la transacción si los emails no coinciden
                }

                if (currentBalanceLitoshis >= totalCostLitoshis) {
                    console.log(`Balance suficiente. Actualizando balance de ${currentBalanceLitoshis} a ${currentBalanceLitoshis - totalCostLitoshis}`);
                    currentData.balance = currentBalanceLitoshis - totalCostLitoshis;
                    return currentData; // Retorna el nuevo estado para que Firebase lo actualice
                } else {
                    console.warn(`Balance insuficiente para ${userId}: ${currentBalanceLitoshis} < ${totalCostLitoshis}. ABORTANDO.`);
                }
            } else {
                console.error(`ERROR en transacción: No se encontraron datos para el usuario ${userId} en la base de datos. ABORTANDO.`); // Log del error si no hay datos
            }
            return; // Aborta la transacción si no hay datos o si alguna de las condiciones previas hizo que se saltara el 'return currentData'
        } catch (transactionCallbackError) { // <--- AÑADIDO: Bloque catch para errores en el callback
            console.error(`ERROR INESPERADO DENTRO DEL CALLBACK DE TRANSACCIÓN para ${userId}:`, transactionCallbackError);
            return; // Aborta la transacción
        }
    });

    console.log("Resultado COMPLETO de la transacción de Firebase:", transactionResult); // Log del resultado completo de la transacción

    if (transactionResult.committed && transactionResult.snapshot && transactionResult.snapshot.val()) {
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
                return; // Abortar si no hay datos (no debería pasar si transactionResult.committed fue true antes)
            });

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
        // Puedes refinar los mensajes de error aquí basándote en la lógica dentro de tu transacción
        if (transactionResult.snapshot && transactionResult.snapshot.val() && transactionResult.snapshot.val().faucetPayEmail !== email) {
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
        const referredUserTransactionResult = await referredUserRef.transaction(currentReferredUserData => {
            if (currentReferredUserData) {
                if (currentReferredUserData.referredByCode || currentReferredUserData.referralClaimed) {
                    return; // Si ya se aplicó en el interín, abortar.
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