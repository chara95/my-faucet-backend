// Carga las variables de entorno desde el archivo .env
import 'dotenv/config'; // Cambiado de require('dotenv').config();

import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch'; // Asegúrate de que node-fetch ^2.6.1 sea compatible con ES modules si hay problemas, o actualiza a ^3.x si quieres usar la versión más reciente con fetch global.
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

// --- Recupera tu API Key de FaucetPay de las variables de entorno ---
const FAUCETPAY_API_KEY = process.env.FAUCETPAY_API_KEY;

// Asegúrate de que la API Key esté configurada
if (!FAUCETPAY_API_KEY || FAUCETPAY_API_KEY === 'TU_API_KEY_REAL_DE_FAUCETPAY_AQUI') {
    console.error('ERROR: FAUCETPAY_API_KEY no está configurada en el archivo .env o es el valor por defecto.');
    console.error('Por favor, reemplaza "TU_API_KEY_REAL_DE_FAUCETPAY_AQUI" en .env con tu clave real.');
    process.exit(1); // Sale de la aplicación si la clave no está configurada
}

const FAUCETPAY_CURRENCY = 'LTC'; // La moneda que vas a usar para validación/pagos

// Configuración de middlewares
// express.json() es preferible a bodyParser.json() para versiones recientes de Express
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

        // --- ¡EL CAMBIO CRUCIAL AQUÍ! ---
        // FaucetPay espera application/x-www-form-urlencoded y el parámetro 'address'
        const formData = new URLSearchParams();
        formData.append('api_key', FAUCETPAY_API_KEY);
        formData.append('address', email); // <--- ¡CORREGIDO! Usando 'address'
        formData.append('currency', FAUCETPAY_CURRENCY); // Añadir la moneda según la documentación si es requerida o útil

        const faucetPayResponse = await fetch(FAUCETPAY_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded', // <--- ¡CORREGIDO!
            },
            body: formData, // <--- ¡Usando URLSearchParams!
        });

        const faucetPayData = await faucetPayResponse.json();

        console.log("Respuesta de FaucetPay:", faucetPayData);

        // --- Manejo de la respuesta de FaucetPay ---
        // Adapta esto a la estructura exacta de respuesta que FaucetPay te da.
        // Basado en tu captura, un status: 200 y message: "OK" con payout_user_hash es éxito.
        // Un status: 456 es "The address does not belong to any user."

        if (faucetPayData.status === 200 && faucetPayData.message === "OK") {
            res.json({
                success: true,
                message: 'Correo electrónico validado con éxito en FaucetPay.',
                payout_user_hash: faucetPayData.payout_user_hash // Pasa el hash si lo necesitas en el frontend
            });
        } else if (faucetPayData.status === 456) {
            res.status(400).json({
                success: false,
                message: faucetPayData.message || 'El correo electrónico no pertenece a ningún usuario de FaucetPay.'
            });
        }
        else {
            // Manejar otros posibles errores o estados de FaucetPay
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

// --- ENDPOINT PARA PROCESAR EL RETIRO (SE HARA EN UN PASO FUTURO) ---
app.post('/api/request-faucetpay-withdrawal', (req, res) => {
    res.status(200).json({ success: false, message: "Funcionalidad de retiro aún no implementada." });
});


// Inicia el servidor Express
app.listen(PORT, () => {
    console.log(`Backend de FaucetPay escuchando en el puerto ${PORT}`);
    // Asegúrate de que la API Key se haya cargado antes de intentar mostrar su longitud
    if (FAUCETPAY_API_KEY) {
        console.log(`FAUCETPAY_API_KEY cargada correctamente (longitud: ${FAUCETPAY_API_KEY.length > 5 ? FAUCETPAY_API_KEY.substring(0, 5) + '...' : 'N/A'})`);
    } else {
        console.log('FAUCETPAY_API_KEY no cargada.');
    }
});