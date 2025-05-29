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
        // --- LLAMADA A LA API DE FAUCETPAY PARA VALIDAR EL CORREO ---
        // **POR FAVOR, REEMPLAZA ESTO CON LA INFORMACIÓN REAL DE LA API DE FAUCETPAY**
        const faucetPayResponse = await fetch('https://faucetpay.io/api/v1/checkaddress', { // <-- ¡ESTA URL ES UN EJEMPLO! ¡CAMBIA!
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                api_key: FAUCETPAY_API_KEY, 
                email: email,               
            })
        });

        const faucetPayData = await faucetPayResponse.json(); 
        
        // EJEMPLO DE RESPUESTA ESPERADA (ADAPTA ESTO A LO REAL DE FAUCETPAY):
        if (faucetPayData.status === 'success' || faucetPayData.valid_email === true) { 
            res.json({ success: true, message: 'Correo electrónico validado con éxito en FaucetPay.' });
        } else {
            console.error('Error de FaucetPay al validar correo:', faucetPayData.message || 'Error desconocido');
            res.status(400).json({ success: false, message: faucetPayData.message || 'El correo electrónico no está registrado o vinculado a FaucetPay.' });
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
    console.log(`FAUCETPAY_API_KEY cargada correctamente (longitud: ${FAUCETPAY_API_KEY.length > 5 ? FAUCETPAY_API_KEY.substring(0, 5) + '...' : 'N/A'})`);
});