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
const MAX_RECONNECT_ATTEMPTS = parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 10;
const RECONNECT_INTERVAL = 5000;

console.log('🔧 Configurações carregadas:');
console.log('   PORT:', PORT);
console.log('   RABBITMQ_URL:', RABBITMQ_URL ? 'Configurado ✅' : 'Não configurado ❌');
console.log('   RABBITMQ_URL (sem credenciais):', RABBITMQ_URL ? RABBITMQ_URL.replace(/\/\/.*:.*@/, '//*****:*****@') : 'N/A');
console.log('   RABBITMQ_VHOST:', RABBITMQ_VHOST ? `"${RABBITMQ_VHOST}" ✅` : 'Não configurado (usará vhost padrão "/") ⚠️');
console.log('   AUTH_TOKEN:', AUTH_TOKEN ? 'Configurado ✅' : 'Não configurado ❌');
console.log('   MAX_RECONNECT_ATTEMPTS:', MAX_RECONNECT_ATTEMPTS);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let connection = null;
let channel = null;
let isReconnecting = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

// Cache de exchanges já verificadas/criadas (para performance)
const exchangeCache = new Set();

async function connectRabbitMQ() {
  if (isReconnecting) {
    console.log('⏳ Já existe uma tentativa de reconexão em andamento...');
    return false;
  }

  try {
    isReconnecting = true;
    reconnectAttempts++;
    
    console.log(`\n🔌 Tentando conectar ao RabbitMQ (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    
    // Validação básica da URL
    if (!RABBITMQ_URL) {
      throw new Error('RABBITMQ_URL não está configurado nas variáveis de ambiente');
    }

    // Monta URL com VHOST
    let connectionUrl = RABBITMQ_URL;
    if (RABBITMQ_VHOST) {
      // Remove barra final da URL se existir
      const baseUrl = RABBITMQ_URL.replace(/\/$/, '');
      // Garante que vhost começa com /
      const vhost = RABBITMQ_VHOST.startsWith('/') ? RABBITMQ_VHOST : `/${RABBITMQ_VHOST}`;
      connectionUrl = `${baseUrl}${vhost}`;
      
      console.log(`   Base URL: ${baseUrl}`);
      console.log(`   VHOST: ${vhost}`);
      console.log(`   URL Final: ${connectionUrl}`);
    } else {
      console.log(`   URL: ${connectionUrl} (vhost padrão "/")`);
    }
    
    console.log('   Conectando...');
    connection = await amqp.connect(connectionUrl);
    console.log('   ✓ Conexão estabelecida');
    
    console.log('   Criando canal...');
    channel = await connection.createChannel();
    console.log('   ✓ Canal criado');
    
    // Limpa cache de exchanges ao reconectar
    exchangeCache.clear();
    
    // Eventos de erro e fechamento
    connection.on('error', handleConnectionError);
    connection.on('close', handleConnectionClose);
    channel.on('error', (err) => {
      console.error('❌ Erro no canal RabbitMQ:', err.message);
    });
    channel.on('close', () => {
      console.warn('⚠️  Canal RabbitMQ foi fechado');
      exchangeCache.clear();
    });
    
    console.log('✅ Conectado ao RabbitMQ com sucesso!\n');
    isReconnecting = false;
    reconnectAttempts = 0;
    
    return true;
  } catch (error) {
    console.error(`\n❌ Erro ao conectar RabbitMQ (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}):`);
    console.error('   Tipo:', error.name);
    console.error('   Mensagem:', error.message);
    
    // Debug adicional para erros comuns
    if (error.message.includes('ECONNREFUSED')) {
      console.error('   💡 Dica: O RabbitMQ não está respondendo. Verifique se está rodando.');
      console.error('      - Docker: docker ps | grep rabbitmq');
      console.error('      - Local: sudo systemctl status rabbitmq-server');
    } else if (error.message.includes('ACCESS_REFUSED') || error.message.includes('403')) {
      console.error('   💡 Dica: Credenciais incorretas ou vhost não existe.');
      console.error('      - Verifique usuário/senha na URL');
      console.error('      - Verifique se o vhost existe no RabbitMQ');
    } else if (error.message.includes('ENOTFOUND')) {
      console.error('   💡 Dica: Host não encontrado. Verifique o hostname na URL.');
    } else if (error.message.includes('timeout')) {
      console.error('   💡 Dica: Timeout na conexão. Firewall ou rede?');
    }
    
    if (error.stack) {
      console.error('   Stack:', error.stack.split('\n').slice(0, 3).join('\n   '));
    }
    
    isReconnecting = false;
    
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('\n💀 Máximo de tentativas de reconexão atingido. Encerrando aplicação...');
      process.exit(1);
    }
    
    return false;
  }
}

function handleConnectionError(err) {
  console.error('\n❌ Erro na conexão RabbitMQ:', err.message);
  channel = null;
  exchangeCache.clear();
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  scheduleReconnect();
}

function handleConnectionClose() {
  console.warn('\n⚠️  Conexão com RabbitMQ foi fechada');
  channel = null;
  connection = null;
  exchangeCache.clear();
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  scheduleReconnect();
}

function scheduleReconnect() {
  if (isReconnecting) {
    console.log('⏳ Reconexão já agendada...');
    return;
  }
  
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('💀 Máximo de tentativas de reconexão atingido. Encerrando aplicação...');
    process.exit(1);
    return;
  }
  
  console.log(`🔄 Aguardando ${RECONNECT_INTERVAL / 1000} segundos para tentar reconectar...`);
  
  reconnectTimer = setTimeout(async () => {
    const connected = await connectRabbitMQ();
    if (!connected) {
      scheduleReconnect();
    }
  }, RECONNECT_INTERVAL);
}

/**
 * Garante que o exchange existe. Se não existir, cria automaticamente.
 * Se já existir, não faz nada (idempotente).
 * 
 * @param {string} exchangeName - Nome do exchange
 * @returns {Promise<boolean>} true se exchange está pronto, false se houve erro
 */
async function ensureExchange(exchangeName) {
  try {
    if (!channel) {
      throw new Error('Canal RabbitMQ não disponível');
    }
    
    // Se já verificamos esse exchange antes, não precisa verificar novamente
    if (exchangeCache.has(exchangeName)) {
      console.log(`✓ Exchange '${exchangeName}' já verificado anteriormente`);
      return true;
    }
    
    console.log(`🔍 Verificando se exchange '${exchangeName}' existe...`);
    
    // assertExchange é IDEMPOTENTE:
    // - Se o exchange NÃO existe → CRIA
    // - Se o exchange JÁ existe → NÃO FAZ NADA (apenas confirma)
    await channel.assertExchange(exchangeName, 'fanout', {
      durable: true  // Exchange persiste após restart do RabbitMQ
    });
    
    // Adiciona ao cache para não verificar novamente
    exchangeCache.add(exchangeName);
    
    console.log(`✅ Exchange '${exchangeName}' está pronto (criado ou já existia)`);
    return true;
    
  } catch (error) {
    console.error(`❌ Erro ao garantir exchange '${exchangeName}':`, error.message);
    
    // Se der erro, remove do cache para tentar novamente depois
    exchangeCache.delete(exchangeName);
    
    return false;
  }
}

app.all('/webhook', async (req, res) => {
  try {
    // 1️⃣ VALIDAÇÃO: Token de autenticação
    const token = req.query.token;
    if (!token || token !== AUTH_TOKEN) {
      return res.status(401).json({
        success: false,
        error: 'Token de autenticação inválido ou ausente'
      });
    }

    // 2️⃣ VALIDAÇÃO: Nome do exchange
    const exchangeName = req.query.exchange;
    if (!exchangeName) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetro "exchange" é obrigatório'
      });
    }

    // 3️⃣ VALIDAÇÃO: Conexão com RabbitMQ
    if (!channel) {
      console.warn('⚠️  Requisição recebida mas RabbitMQ está desconectado');
      
      if (!isReconnecting && !reconnectTimer) {
        scheduleReconnect();
      }
      
      return res.status(503).json({
        success: false,
        error: 'RabbitMQ não está conectado. Tentando reconectar...',
        reconnectAttempt: reconnectAttempts,
        maxAttempts: MAX_RECONNECT_ATTEMPTS
      });
    }

    // 4️⃣ GARANTIR QUE EXCHANGE EXISTE (cria se não existir)
    console.log(`\n📥 Webhook recebido - Exchange: '${exchangeName}'`);
    const exchangeReady = await ensureExchange(exchangeName);
    
    if (!exchangeReady) {
      return res.status(500).json({
        success: false,
        error: 'Não foi possível preparar o exchange no RabbitMQ',
        exchange: exchangeName
      });
    }

    // 5️⃣ PREPARAR DADOS para enviar
    const queryParams = { ...req.query };
    delete queryParams.exchange;
    delete queryParams.token;

    const dataToSend = {
      timestamp: new Date().toISOString(),
      method: req.method,
      params: queryParams,
      body: req.body,
      headers: req.headers,
      ip: req.ip,
      path: req.path,
      originalUrl: req.originalUrl
    };

    // 6️⃣ PUBLICAR mensagem no exchange
    const message = Buffer.from(JSON.stringify(dataToSend));
    
    channel.publish(exchangeName, '', message, {
      persistent: true,              // Mensagem sobrevive a restart do RabbitMQ
      contentType: 'application/json',
      timestamp: Date.now()
    });

    console.log(`📤 Dados enviados com sucesso para exchange '${exchangeName}'`);

    // 7️⃣ RESPONDER ao cliente
    res.status(200).json({
      success: true,
      message: 'Dados recebidos e enviados para RabbitMQ',
      exchange: exchangeName,
      timestamp: dataToSend.timestamp
    });

  } catch (error) {
    console.error('❌ Erro ao processar webhook:', error.message);
    
    // Se o erro for relacionado ao canal/conexão, limpa e agenda reconexão
    if (error.message.includes('Channel closed') || 
        error.message.includes('Connection closed') ||
        error.message.includes('Channel ended')) {
      channel = null;
      exchangeCache.clear();
      scheduleReconnect();
    }
    
    res.status(500).json({
      success: false,
      error: 'Erro ao processar webhook',
      details: error.message
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rabbitmq: channel ? 'connected' : 'disconnected',
    reconnectAttempts: reconnectAttempts,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    isReconnecting: isReconnecting,
    exchangesInCache: exchangeCache.size,
    timestamp: new Date().toISOString()
  });
});

// Endpoint de debug para testar conexão
app.get('/debug', async (req, res) => {
  const debugInfo = {
    env: {
      RABBITMQ_URL_SET: !!RABBITMQ_URL,
      RABBITMQ_VHOST: RABBITMQ_VHOST || 'not set (default "/")',
      AUTH_TOKEN_SET: !!AUTH_TOKEN,
      MAX_RECONNECT_ATTEMPTS: MAX_RECONNECT_ATTEMPTS
    },
    connection: {
      isConnected: !!channel,
      reconnectAttempts: reconnectAttempts,
      isReconnecting: isReconnecting,
      hasReconnectTimer: !!reconnectTimer
    },
    exchanges: {
      cachedCount: exchangeCache.size,
      cached: Array.from(exchangeCache)
    },
    timestamp: new Date().toISOString()
  };
  
  res.json(debugInfo);
});

async function start() {
  const connected = await connectRabbitMQ();
  
  if (!connected && reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('💀 Não foi possível conectar ao RabbitMQ após múltiplas tentativas. Encerrando...');
    process.exit(1);
  }
  
  if (!connected) {
    console.warn('⚠️  Iniciando servidor sem conexão com RabbitMQ. Tentará reconectar automaticamente...');
    scheduleReconnect();
  }
  
  app.listen(PORT, () => {
    console.log(`\n🚀 API rodando na porta ${PORT}`);
    console.log(`📍 Webhook: http://localhost:${PORT}/webhook?exchange=NOME&token=TOKEN`);
    console.log(`💚 Health: http://localhost:${PORT}/health`);
    console.log(`🐛 Debug: http://localhost:${PORT}/debug`);
  });
}

process.on('SIGINT', async () => {
  console.log('\n⏹️  Encerrando aplicação...');
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
    console.log('✅ Conexões fechadas com sucesso');
  } catch (error) {
    console.error('❌ Erro ao fechar conexões:', error.message);
  }
  
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

start();