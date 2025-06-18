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


// --- ENDPOINT PARA PROCESAR EL RETIRO (SEGURO Y CONDICIONAL) ---
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

    if (withdrawalAmountLitoshis < MIN_WITHDRAWAL_LITOSHIS_BACKEND) {
        return res.status(400).json({ success: false, message: `La cantidad mínima de retiro es ${(MIN_WITHDRAWAL_LITOSHIS_BACKEND / LTC_TO_LITOSHIS_FACTOR).toFixed(8)} LTC.` });
    }

    const totalCostLitoshis = withdrawalAmountLitoshis + WITHDRAWAL_FEE_LITOSHIS;

    const userRef = db.ref(`users/${userId}`);

    // --- 1. Leer datos del usuario (saldo y email de FaucetPay) ---
    let currentBalanceLitoshis;
    let storedFaucetPayEmail;
    try {
        const snapshot = await userRef.once('value'); // Lectura directa que sabemos que funciona
        if (snapshot.exists()) {
            const userData = snapshot.val();
            currentBalanceLitoshis = userData.balance || 0;
            storedFaucetPayEmail = userData.faucetPayEmail;
            console.log(`Datos del usuario ${userId} leídos:`, userData);
        } else {
            console.error(`Error: Datos de usuario no encontrados para ${userId}.`);
            return res.status(404).json({ success: false, message: 'Datos de usuario no encontrados.' });
        }
    } catch (readError) {
        console.error(`Error al leer datos del usuario ${userId}:`, readError);
        return res.status(500).json({ success: false, message: 'Error interno al verificar datos del usuario.' });
    }

    // --- 2. Validaciones de Seguridad en Backend ---
    if (storedFaucetPayEmail !== email) {
        console.warn(`Discrepancia de email FaucetPay para ${userId}: Cliente envió '${email}', DB tiene '${storedFaucetPayEmail}'. ABORTANDO.`);
        return res.status(400).json({ success: false, message: 'El correo de FaucetPay en tu cuenta no coincide con el de la solicitud.' });
    }

    // Re-validación del saldo en el backend (muy importante, no confíes solo en el frontend)
    if (currentBalanceLitoshis < totalCostLitoshis) {
        console.warn(`Backend: Balance insuficiente para ${userId}: ${currentBalanceLitoshis} < ${totalCostLitoshis}. ABORTANDO.`);
        return res.status(400).json({ success: false, message: 'Balance insuficiente para el retiro en el backend.' });
    }

    // --- 3. Enviar solicitud a FaucetPay ---
    const FAUCETPAY_SEND_URL = 'https://faucetpay.io/api/v1/send';
    const formData = new URLSearchParams();
    formData.append('api_key', FAUCETPAY_API_KEY);
    formData.append('to', email);
    formData.append('amount', withdrawalAmountLitoshis);
    formData.append('currency', FAUCETPAY_CURRENCY);

    console.log(`Enviando solicitud de retiro a FaucetPay para ${userId} (Email: ${email}, Monto: ${withdrawalAmountLitoshis} Litoshis)...`);

    try {
        const faucetPayResponse = await fetch(FAUCETPAY_SEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData,
        });
        const faucetPayData = await faucetPayResponse.json();

        console.log("Respuesta de FaucetPay (envío):", faucetPayData);

        // --- 4. Procesar respuesta de FaucetPay y Actualizar Firebase Condicionalmente ---
        if (faucetPayData.status === 200 && faucetPayData.message === "OK") {
            // **FAUCETPAY OK**: Deduce el saldo y registra la transacción exitosa
            console.log(`Pago FaucetPay exitoso. Deduciendo balance de ${userId} y registrando transacción.`);

            const newBalanceAfterWithdrawal = currentBalanceLitoshis - totalCostLitoshis;

            try {
                // Actualiza el campo 'balance' directamente (sin transaction)
                await userRef.update({
                    balance: newBalanceAfterWithdrawal
                });
                console.log(`Balance de ${userId} actualizado a ${newBalanceAfterWithdrawal} Litoshis.`);

                // Registra la transacción como completada
                db.ref(`transactions/${userId}`).push({
                    type: 'withdrawal',
                    amount: withdrawalAmountLitoshis,
                    fee: WITHDRAWAL_FEE_LITOSHIS,
                    faucetPayEmail: email,
                    timestamp: admin.database.ServerValue.TIMESTAMP,
                    status: 'completed',
                    faucetPayTxId: faucetPayData.payout_id || 'N/A',
                });
                console.log(`Transacción de retiro exitosa registrada para ${userId}.`);

                res.json({
                    success: true,
                    message: 'Retiro procesado y balance actualizado con éxito.',
                    payout_id: faucetPayData.payout_id,
                    balance: newBalanceAfterWithdrawal // Envía el nuevo balance al frontend
                });

            } catch (firebaseUpdateError) {
                // FaucetPay fue OK, pero la deducción de balance en Firebase falló.
                // ESTO ES CRÍTICO: Registra el incidente y alerta.
                console.error(`Advertencia CRÍTICA: FaucetPay exitoso, pero la deducción de balance en Firebase falló para ${userId}:`, firebaseUpdateError);
                db.ref(`transactions/${userId}`).push({
                    type: 'withdrawal_firebase_deduction_failed_after_faucetpay_ok',
                    amount: withdrawalAmountLitoshis,
                    fee: WITHDRAWAL_FEE_LITOSHIS,
                    faucetPayEmail: email,
                    timestamp: admin.database.ServerValue.TIMESTAMP,
                    status: 'error_balance_deduction',
                    faucetPayTxId: faucetPayData.payout_id || 'N/A',
                    errorMessage: 'Deducción de balance falló en Firebase después de pago OK en FaucetPay.'
                });
                res.status(500).json({
                    success: false,
                    message: 'Error crítico: Pago realizado en FaucetPay, pero el balance no pudo ser actualizado. Contacta al soporte.'
                });
            }

        } else {
            // **FAUCETPAY FALLÓ**: NO deduce el saldo. Solo registra la transacción fallida.
            console.error(`Fallo de FaucetPay para ${userId}. NO se deduce balance. Mensaje FaucetPay: ${faucetPayData.message || 'Desconocido'}`);
            db.ref(`transactions/${userId}`).push({
                type: 'withdrawal_failed_faucetpay',
                amount: withdrawalAmountLitoshis,
                fee: WITHDRAWAL_FEE_LITOSHIS,
                faucetPayEmail: email,
                timestamp: admin.database.ServerValue.TIMESTAMP,
                status: 'failed_external',
                errorMessage: faucetPayData.message || 'Error desconocido de FaucetPay.',
            });
            res.status(400).json({
                success: false,
                message: faucetPayData.message || 'Error al procesar el retiro con FaucetPay. Tus fondos no fueron afectados.'
            });
        }
    } catch (faucetPayNetworkError) {
        // Error de red/conexión al comunicarse con FaucetPay.
        console.error(`Error de red/conexión al comunicarse con FaucetPay para ${userId}:`, faucetPayNetworkError);
        res.status(500).json({ success: false, message: 'Error de conexión con el servicio de retiro. Intenta de nuevo más tarde.' });
    }
});





// --- ENDPOINT PARA APLICAR CÓDIGO DE REFERIDO (CON AUTENTICACIÓN) ---
// Asegúrate de que admin y db estén inicializados al inicio de tu server.js
// const admin = require('firebase-admin');
// const db = admin.database();

// --- ENDPOINT PARA PROCESAR EL RETIRO (SEGURO Y CONDICIONAL) ---
// --- ENDPOINT PARA PROCESAR EL RETIRO (SEGURO, CONDICIONAL, Guarda en transactions Y activities) ---
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

    if (withdrawalAmountLitoshis < MIN_WITHDRAWAL_LITOSHIS_BACKEND) {
        return res.status(400).json({ success: false, message: `La cantidad mínima de retiro es ${(MIN_WITHDRAWAL_LITOSHIS_BACKEND / LTC_TO_LITOSHIS_FACTOR).toFixed(8)} LTC.` });
    }

    const totalCostLitoshis = withdrawalAmountLitoshis + WITHDRAWAL_FEE_LITOSHIS;

    const userRef = db.ref(`users/${userId}`);
    const userActivitiesRef = db.ref(`users/${userId}/activities`); // Sub-nodo de actividades
    const transactionsRef = db.ref(`transactions/${userId}`); // Nodo de transacciones de nivel superior

    // --- 1. Leer datos del usuario (saldo y email de FaucetPay) ---
    let currentBalanceLitoshis;
    let storedFaucetPayEmail;
    try {
        const snapshot = await userRef.once('value');
        if (snapshot.exists()) {
            const userData = snapshot.val();
            currentBalanceLitoshis = userData.balance || 0;
            storedFaucetPayEmail = userData.faucetPayEmail;
            console.log(`Datos del usuario ${userId} leídos:`, userData);
        } else {
            console.error(`Error: Datos de usuario no encontrados para ${userId}.`);
            return res.status(404).json({ success: false, message: 'Datos de usuario no encontrados.' });
        }
    } catch (readError) {
        console.error(`Error al leer datos del usuario ${userId}:`, readError);
        return res.status(500).json({ success: false, message: 'Error interno al verificar datos del usuario.' });
    }

    // --- 2. Validaciones de Seguridad en Backend ---
    if (storedFaucetPayEmail !== email) {
        console.warn(`Discrepancia de email FaucetPay para ${userId}: Cliente envió '${email}', DB tiene '${storedFaucetPayEmail}'. ABORTANDO.`);
        return res.status(400).json({ success: false, message: 'El correo de FaucetPay en tu cuenta no coincide con el de la solicitud.' });
    }

    // Re-validación del saldo en el backend (muy importante, no confíes solo en el frontend)
    if (currentBalanceLitoshis < totalCostLitoshis) {
        console.warn(`Backend: Balance insuficiente para ${userId}: ${currentBalanceLitoshis} < ${totalCostLitoshis}. ABORTANDO.`);
        return res.status(400).json({ success: false, message: 'Balance insuficiente para el retiro en el backend.' });
    }

    // --- 3. Enviar solicitud a FaucetPay ---
    const FAUCETPAY_SEND_URL = 'https://faucetpay.io/api/v1/send';
    const formData = new URLSearchParams();
    formData.append('api_key', FAUCETPAY_API_KEY);
    formData.append('to', email);
    formData.append('amount', withdrawalAmountLitoshis);
    formData.append('currency', FAUCETPAY_CURRENCY);

    console.log(`Enviando solicitud de retiro a FaucetPay para ${userId} (Email: ${email}, Monto: ${withdrawalAmountLitoshis} Litoshis)...`);

    try {
        const faucetPayResponse = await fetch(FAUCETPAY_SEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData,
        });
        const faucetPayData = await faucetPayResponse.json();

        console.log("Respuesta de FaucetPay (envío):", faucetPayData);

        // --- 4. Procesar respuesta de FaucetPay y Actualizar Firebase Condicionalmente ---
        if (faucetPayData.status === 200 && faucetPayData.message === "OK") {
            // **FAUCETPAY OK**: Deduce el saldo y registra ambas transacciones
            console.log(`Pago FaucetPay exitoso. Deduciendo balance de ${userId} y registrando transacciones.`);

            const newBalanceAfterWithdrawal = currentBalanceLitoshis - totalCostLitoshis;

            try {
                // Actualiza el campo 'balance' directamente
                await userRef.update({
                    balance: newBalanceAfterWithdrawal
                });
                console.log(`Balance de ${userId} actualizado a ${newBalanceAfterWithdrawal} Litoshis.`);

                // ****** REGISTRAR EN NODO 'transactions' (nivel superior) ******
                await transactionsRef.push({
                    type: 'withdrawal',
                    amount: withdrawalAmountLitoshis,
                    fee: WITHDRAWAL_FEE_LITOSHIS,
                    faucetPayEmail: email,
                    timestamp: admin.database.ServerValue.TIMESTAMP,
                    status: 'completed',
                    faucetPayTxId: faucetPayData.payout_id || 'N/A',
                });
                console.log(`Transacción de retiro exitosa registrada en 'transactions/${userId}'.`);
                // ***************************************************************

                // ****** REGISTRAR ACTIVIDAD EN SUB-NODO 'activities' dentro del usuario ******
                await userActivitiesRef.push({
                    type: 'Retiro',
                    amount: withdrawalAmountLitoshis,
                    fee: WITHDRAWAL_FEE_LITOSHIS,
                    currency: FAUCETPAY_CURRENCY,
                    status: 'Completado',
                    timestamp: admin.database.ServerValue.TIMESTAMP,
                    message: `Retiro de ${withdrawalAmountLTC.toFixed(8)} LTC a ${email} completado.`,
                    txId: faucetPayData.payout_id || 'N/A' // ID de la transacción de FaucetPay
                });
                console.log(`Actividad de retiro exitosa registrada en 'users/${userId}/activities'.`);
                // ********************************************************************************

                res.json({
                    success: true,
                    message: 'Retiro procesado y balance actualizado con éxito.',
                    payout_id: faucetPayData.payout_id,
                    balance: newBalanceAfterWithdrawal // Envía el nuevo balance al frontend
                });

            } catch (firebaseUpdateError) {
                // FaucetPay fue OK, pero la deducción de balance en Firebase falló.
                console.error(`Advertencia CRÍTICA: FaucetPay exitoso, pero la deducción de balance en Firebase falló para ${userId}:`, firebaseUpdateError);
                // Registrar el incidente en ambos nodos para depuración
                await transactionsRef.push({
                    type: 'withdrawal_firebase_deduction_failed_after_faucetpay_ok',
                    amount: withdrawalAmountLitoshis,
                    fee: WITHDRAWAL_FEE_LITOSHIS,
                    faucetPayEmail: email,
                    timestamp: admin.database.ServerValue.TIMESTAMP,
                    status: 'error_balance_deduction',
                    faucetPayTxId: faucetPayData.payout_id || 'N/A',
                    errorMessage: 'Deducción de balance falló en Firebase después de pago OK en FaucetPay.'
                });
                await userActivitiesRef.push({
                    type: 'Retiro',
                    amount: withdrawalAmountLitoshis,
                    fee: WITHDRAWAL_FEE_LITOSHIS,
                    currency: FAUCETPAY_CURRENCY,
                    status: 'Error Crítico',
                    timestamp: admin.database.ServerValue.TIMESTAMP,
                    message: `ERROR: Retiro de ${withdrawalAmountLTC.toFixed(8)} LTC procesado por FaucetPay, pero no se pudo deducir el balance.`,
                    txId: faucetPayData.payout_id || 'N/A'
                });

                res.status(500).json({
                    success: false,
                    message: 'Error crítico: Pago realizado en FaucetPay, pero el balance no pudo ser actualizado. Contacta al soporte.'
                });
            }

        } else {
            // **FAUCETPAY FALLÓ**: NO deduce el saldo. Registra la transacción fallida en ambos.
            console.error(`Fallo de FaucetPay para ${userId}. NO se deduce balance. Mensaje FaucetPay: ${faucetPayData.message || 'Desconocido'}`);
            // ****** REGISTRAR EN NODO 'transactions' (nivel superior) ******
            await transactionsRef.push({
                type: 'withdrawal_failed_faucetpay',
                amount: withdrawalAmountLitoshis,
                fee: WITHDRAWAL_FEE_LITOSHIS,
                faucetPayEmail: email,
                timestamp: admin.database.ServerValue.TIMESTAMP,
                status: 'failed_external',
                errorMessage: faucetPayData.message || 'Error desconocido de FaucetPay.',
            });
            console.log(`Transacción de retiro fallida registrada en 'transactions/${userId}'.`);
            // ***************************************************************

            // ****** REGISTRAR ACTIVIDAD FALLIDA EN SUB-NODO 'activities' dentro del usuario ******
            await userActivitiesRef.push({
                type: 'Retiro',
                amount: withdrawalAmountLitoshis,
                fee: WITHDRAWAL_FEE_LITOSHIS,
                currency: FAUCETPAY_CURRENCY,
                status: 'Fallido',
                timestamp: admin.database.ServerValue.TIMESTAMP,
                message: `Retiro de ${withdrawalAmountLTC.toFixed(8)} LTC fallido. Mensaje: ${faucetPayData.message || 'Error desconocido de FaucetPay.'}`,
                txId: 'N/A' // No hay ID de transacción de FaucetPay si falló el envío
            });
            console.log(`Actividad de retiro fallida registrada en 'users/${userId}/activities'.`);
            // **************************************************************************************

            res.status(400).json({
                success: false,
                message: faucetPayData.message || 'Error al procesar el retiro con FaucetPay. Tus fondos no fueron afectados.'
            });
        }
    } catch (faucetPayNetworkError) {
        // Error de red/conexión al comunicarse con FaucetPay.
        console.error(`Error de red/conexión al comunicarse con FaucetPay para ${userId}:`, faucetPayNetworkError);

        // Registrar el error de red en ambos nodos
        await transactionsRef.push({
            type: 'withdrawal_network_error',
            amount: withdrawalAmountLitoshis,
            fee: WITHDRAWAL_FEE_LITOSHIS,
            faucetPayEmail: email,
            timestamp: admin.database.ServerValue.TIMESTAMP,
            status: 'failed_network',
            errorMessage: faucetPayNetworkError.message || 'Error de conexión con FaucetPay.'
        });
        await userActivitiesRef.push({
            type: 'Retiro',
            amount: withdrawalAmountLitoshis,
            fee: WITHDRAWAL_FEE_LITOSHIS,
            currency: FAUCETPAY_CURRENCY,
            status: 'Error de Conexión',
            timestamp: admin.database.ServerValue.TIMESTAMP,
            message: `Retiro de ${withdrawalAmountLTC.toFixed(8)} LTC fallido por error de conexión.`,
            txId: 'N/A'
        });
        console.log(`Actividad de retiro (error de conexión) registrada en 'transactions' y 'users/${userId}/activities'.`);

        res.status(500).json({ success: false, message: 'Error de conexión con el servicio de retiro. Intenta de nuevo más tarde.' });
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