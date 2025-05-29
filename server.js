// Carga las variables de entorno desde el archivo .env
import 'dotenv/config'; // Cambiado de require('dotenv').config();

import express from 'express'; // Cambiado de const express = require('express');
import bodyParser from 'body-parser'; // Cambiado de const bodyParser = require('body-parser');
import fetch from 'node-fetch'; // Cambiado de const fetch = require('node-fetch');
import cors from 'cors'; // Cambiado de const cors = require('cors');

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
app.use(bodyParser.json()); 
app.use(cors()); 

// --- ENDPOINT PARA VALIDAR EL CORREO ELECTRÓNICO CON FAUCETPAY ---
app.post('/api/validate-faucetpay-email', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: 'Email es requerido.' });
    }

    try {
        const FAUCETPAY_API_URL = 'https://faucetpay.io/api/v1/checkaddress'; // Esta URL es correcta

        // Construir el body como URL-encoded form data
        const formData = new URLSearchParams();
        formData.append('api_key', FAUCETPAY_API_KEY);
        formData.append('address', email); // <-- ¡CORREGIDO: 'address' en lugar de 'email'!
        formData.append('currency', FAUCETPAY_CURRENCY); // Opcional, pero bueno incluirlo si aplica

        const faucetPayResponse = await fetch(FAUCETPAY_API_URL, {
            method: 'POST',
            // --- ¡IMPORTANTE! Cambiado el Content-Type y el body ---
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded', // <-- ¡CORREGIDO!
            },
            body: formData, // <-- ¡Ahora es formData, no JSON.stringify!
        });

        const faucetPayData = await faucetPayResponse.json();

        console.log("Respuesta de FaucetPay:", faucetPayData); // Asegúrate de que esto se imprime en los logs de Render

        // La lógica para manejar la respuesta de FaucetPay basada en tu documentación
        // La documentación muestra 'status: 200' para éxito y 'status: 456' para no encontrado.
        if (faucetPayData.status === 200) {
            res.json({ success: true, message: 'Correo electrónico validado con éxito en FaucetPay.', user_hash: faucetPayData.payout_user_hash });
        } else if (faucetPayData.status === 456) {
            res.status(400).json({ success: false, message: faucetPayData.message || 'El correo electrónico no pertenece a ningún usuario de FaucetPay.' });
        } else {
            console.error('Error de FaucetPay al validar correo (otro estado):', faucetPayData.message || 'Error desconocido');
            res.status(500).json({ success: false, message: faucetPayData.message || 'Error desconocido de FaucetPay.' });
        }

    } catch (error) {
        console.error('Error interno del servidor al validar el correo:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor al validar el correo.' });
    }
});


// Inicia el servidor Express
app.listen(PORT, () => {
    console.log(`Backend de FaucetPay escuchando en el puerto ${PORT}`);
    console.log(`FAUCETPAY_API_KEY cargada correctamente (longitud: ${FAUCETPAY_API_KEY.length > 5 ? FAUCETPAY_API_KEY.substring(0, 5) + '...' : 'N/A'})`);
});