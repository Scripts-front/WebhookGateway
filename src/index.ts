const express = require('express');
const amqp = require('amqplib');

// Carrega .env apenas se não estiver usando Docker
if (!process.env.DOCKER_ENV) {
  require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 3000;
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const RABBITMQ_VHOST = process.env.RABBITMQ_VHOST;

console.log('🔧 Configurações carregadas:');
console.log('   PORT:', PORT);
console.log('   RABBITMQ_URL:', RABBITMQ_URL ? 'Configurado ✅' : 'Não configurado ❌');
console.log('   RABBITMQ_VHOST:', RABBITMQ_VHOST ? `"${RABBITMQ_VHOST}" ✅` : 'Não configurado (usará vhost padrão do RabbitMQ) ⚠️');
console.log('   AUTH_TOKEN:', AUTH_TOKEN ? 'Configurado ✅' : 'Não configurado ❌');

// Middleware para parsear JSON e URL encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Armazena a conexão do RabbitMQ
let connection = null;
let channel = null;
let isReconnecting = false;

// Conecta ao RabbitMQ com retry
async function connectRabbitMQ() {
  if (isReconnecting) {
    console.log('⏳ Já existe uma tentativa de reconexão em andamento...');
    return false;
  }

  try {
    isReconnecting = true;
    console.log('🔌 Tentando conectar ao RabbitMQ...');
    
    // Monta URL com VHOST se fornecido
    let connectionUrl = RABBITMQ_URL;
    if (RABBITMQ_VHOST) {
      // Adiciona / no início se não tiver
      const vhost = RABBITMQ_VHOST.startsWith('/') ? RABBITMQ_VHOST : `/${RABBITMQ_VHOST}`;
      connectionUrl = `${RABBITMQ_URL}${vhost}`;
      console.log(`   URL: ${RABBITMQ_URL}`);
      console.log(`   VHOST: ${vhost}`);
    } else {
      console.log(`   URL: ${connectionUrl} (sem vhost específico)`);
    }
    
    connection = await amqp.connect(connectionUrl);
    channel = await connection.createChannel();
    
    // Eventos de erro e fechamento
    connection.on('error', handleConnectionError);
    connection.on('close', handleConnectionClose);
    
    console.log('✅ Conectado ao RabbitMQ com sucesso!');
    isReconnecting = false;
    return true;
  } catch (error) {
    console.error('❌ Erro ao conectar RabbitMQ:', error.message);
    isReconnecting = false;
    return false;
  }
}

// Trata erro de conexão
function handleConnectionError(err) {
  console.error('❌ Erro na conexão RabbitMQ:', err.message);
  channel = null;
  scheduleReconnect();
}

// Trata fechamento de conexão
function handleConnectionClose() {
  console.warn('⚠️  Conexão com RabbitMQ foi fechada');
  channel = null;
  connection = null;
  scheduleReconnect();
}

// Agenda reconexão após 5 segundos
function scheduleReconnect() {
  if (isReconnecting) return;
  
  console.log('🔄 Aguardando 5 segundos para tentar reconectar...');
  setTimeout(async () => {
    console.log('🔄 Tentando reconectar ao RabbitMQ...');
    const connected = await connectRabbitMQ();
    if (!connected) {
      scheduleReconnect();
    }
  }, 5000);
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
    if (!token || token !== AUTH_TOKEN) {
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
      return res.status(503).json({
        success: false,
        error: 'RabbitMQ não está conectado. Tentando reconectar...'
      });
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

start();
