const express = require('express');
const amqp = require('amqplib');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para parsear JSON e URL encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Armazena a conexão do RabbitMQ
let connection = null;
let channel = null;

// Conecta ao RabbitMQ
async function connectRabbitMQ() {
  try {
    connection = await amqp.connect(process.env.RABBITMQ_URL);
    channel = await connection.createChannel();
    console.log('✅ Conectado ao RabbitMQ');
    return true;
  } catch (error) {
    console.error('❌ Erro ao conectar RabbitMQ:', error.message);
    return false;
  }
}

// Verifica se exchange existe, se não, cria
async function ensureExchange(exchangeName) {
  try {
    await channel.assertExchange(exchangeName, 'fanout', {
      durable: true
    });
    console.log(`✅ Exchange '${exchangeName}' pronta`);
    return true;
  } catch (error) {
    console.error(`❌ Erro ao verificar/criar exchange '${exchangeName}':`, error.message);
    return false;
  }
}

// Endpoint webhook - aceita todos os métodos HTTP
app.all('/webhook', async (req, res) => {
  try {
    // Verifica token de autenticação
    const token = req.query.token;
    if (!token || token !== process.env.AUTH_TOKEN) {
      return res.status(401).json({
        success: false,
        error: 'Token de autenticação inválido ou ausente'
      });
    }

    // Verifica se exchange foi especificada
    const exchangeName = req.query.exchange;
    if (!exchangeName) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetro "exchange" é obrigatório'
      });
    }

    // Verifica conexão com RabbitMQ
    if (!channel) {
      const connected = await connectRabbitMQ();
      if (!connected) {
        return res.status(500).json({
          success: false,
          error: 'Falha ao conectar com RabbitMQ'
        });
      }
    }

    // Garante que a exchange existe
    await ensureExchange(exchangeName);

    // Remove exchange e token dos query params para não enviar ao RabbitMQ
    const queryParams = { ...req.query };
    delete queryParams.exchange;
    delete queryParams.token;

    // Coleta TODOS os dados recebidos
    const dataToSend = {
      timestamp: new Date().toISOString(),
      method: req.method,
      params: queryParams,      // Query parameters
      body: req.body,           // Body da requisição
      headers: req.headers,     // Todos os headers
      ip: req.ip,              // IP do cliente
      path: req.path,          // Caminho da URL
      originalUrl: req.originalUrl
    };

    // Publica mensagem na exchange
    const message = Buffer.from(JSON.stringify(dataToSend));
    channel.publish(exchangeName, '', message, {
      persistent: true,
      contentType: 'application/json',
      timestamp: Date.now()
    });

    console.log(`📤 Dados enviados para exchange '${exchangeName}'`);
    console.log(`📦 Payload:`, JSON.stringify(dataToSend, null, 2));

    res.status(200).json({
      success: true,
      message: 'Dados recebidos e enviados para RabbitMQ',
      exchange: exchangeName,
      timestamp: dataToSend.timestamp
    });

  } catch (error) {
    console.error('❌ Erro ao processar webhook:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao processar webhook',
      details: error.message
    });
  }
});

// Endpoint de health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rabbitmq: channel ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// Inicia servidor
async function start() {
  await connectRabbitMQ();
  
  app.listen(PORT, () => {
    console.log(`🚀 API rodando na porta ${PORT}`);
    console.log(`📍 Webhook: http://localhost:${PORT}/webhook?exchange=NOME&token=TOKEN`);
    console.log(`💚 Health: http://localhost:${PORT}/health`);
  });
}

// Fecha conexões ao encerrar
process.on('SIGINT', async () => {
  console.log('\n⏹️  Fechando conexões...');
  if (channel) await channel.close();
  if (connection) await connection.close();
  process.exit(0);
});

// Reconecta automaticamente se perder conexão
connection?.on('error', async (err) => {
  console.error('❌ Erro na conexão RabbitMQ:', err.message);
  console.log('🔄 Tentando reconectar...');
  await connectRabbitMQ();
});

start();