import express from 'express';
import type { Request, Response } from 'express';
import amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';

// Carrega .env apenas se não estiver usando Docker
if (!process.env.DOCKER_ENV) {
  require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 3000;
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const RABBITMQ_VHOST = process.env.RABBITMQ_VHOST;
const MAX_RECONNECT_ATTEMPTS = parseInt(process.env.MAX_RECONNECT_ATTEMPTS || '10', 10);
const RECONNECT_INTERVAL = 5000;
// Se true, pula validação quando fila/exchange está em cache (mais rápido, mas pode ter falso positivo se deletado manualmente)
// Se false, sempre valida mesmo que esteja em cache (mais seguro, garante que fila/exchange existe)
const ENABLE_CACHE_SKIP = process.env.ENABLE_CACHE_SKIP === 'true';

console.log('🔧 Configurações carregadas:');
console.log('   PORT:', PORT);
console.log('   RABBITMQ_URL:', RABBITMQ_URL ? 'Configurado ✅' : 'Não configurado ❌');
console.log('   AUTH_TOKEN:', AUTH_TOKEN ? 'Configurado ✅' : 'Não configurado ❌');
console.log('   MAX_RECONNECT_ATTEMPTS:', MAX_RECONNECT_ATTEMPTS);
console.log('   ENABLE_CACHE_SKIP:', ENABLE_CACHE_SKIP ? '✅ Habilitado (rápido)' : '❌ Desabilitado (seguro)');

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let isReconnecting = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Cache de exchanges já verificadas/criadas (para performance)
const exchangeCache = new Set<string>();

// Cache de filas já verificadas/criadas (para performance)
const queueCache = new Set<string>();

async function connectRabbitMQ(): Promise<boolean> {
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

    // Limpa cache de exchanges e filas ao reconectar
    exchangeCache.clear();
    queueCache.clear();

    // Eventos de erro e fechamento
    connection.on('error', handleConnectionError);
    connection.on('close', handleConnectionClose);
    channel.on('error', (err: Error) => {
      console.error('❌ Erro no canal RabbitMQ:', err.message);
    });
    channel.on('close', () => {
      console.warn('⚠️  Canal RabbitMQ foi fechado');
      exchangeCache.clear();
      queueCache.clear();
    });

    console.log('✅ Conectado ao RabbitMQ com sucesso!\n');
    isReconnecting = false;
    reconnectAttempts = 0;

    return true;
  } catch (error: unknown) {
    const err = error as Error;
    console.error(`\n❌ Erro ao conectar RabbitMQ (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}):`);
    console.error('   Tipo:', err.name);
    console.error('   Mensagem:', err.message);

    // Debug adicional para erros comuns
    if (err.message.includes('ECONNREFUSED')) {
      console.error('   💡 Dica: O RabbitMQ não está respondendo. Verifique se está rodando.');
      console.error('      - Docker: docker ps | grep rabbitmq');
      console.error('      - Local: sudo systemctl status rabbitmq-server');
    } else if (err.message.includes('ACCESS_REFUSED') || err.message.includes('403')) {
      console.error('   💡 Dica: Credenciais incorretas ou vhost não existe.');
      console.error('      - Verifique usuário/senha na URL');
      console.error('      - Verifique se o vhost existe no RabbitMQ');
    } else if (err.message.includes('ENOTFOUND')) {
      console.error('   💡 Dica: Host não encontrado. Verifique o hostname na URL.');
    } else if (err.message.includes('timeout')) {
      console.error('   💡 Dica: Timeout na conexão. Firewall ou rede?');
    }

    if (err.stack) {
      console.error('   Stack:', err.stack.split('\n').slice(0, 3).join('\n   '));
    }

    isReconnecting = false;

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('\n💀 Máximo de tentativas de reconexão atingido. Encerrando aplicação...');
      process.exit(1);
    }

    return false;
  }
}

function handleConnectionError(err: Error) {
  console.error('\n❌ Erro na conexão RabbitMQ:', err.message);
  channel = null;
  exchangeCache.clear();
  queueCache.clear();

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
  queueCache.clear();

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
async function ensureExchange(exchangeName: string): Promise<boolean> {
  try {
    if (!channel) {
      throw new Error('Canal RabbitMQ não disponível');
    }

    // Se ENABLE_CACHE_SKIP está ativo e exchange está em cache, pula validação
    if (ENABLE_CACHE_SKIP && exchangeCache.has(exchangeName)) {
      console.log(`✓ Exchange '${exchangeName}' já verificado anteriormente (cache ativo)`);
      return true;
    }

    const wasCached = exchangeCache.has(exchangeName);

    if (wasCached) {
      console.log(`🔍 Revalidando exchange '${exchangeName}' (estava em cache)...`);
    } else {
      console.log(`🔍 Verificando se exchange '${exchangeName}' existe...`);
    }

    // assertExchange é IDEMPOTENTE:
    // - Se o exchange NÃO existe → CRIA
    // - Se o exchange JÁ existe → NÃO FAZ NADA (apenas confirma)
    await channel.assertExchange(exchangeName, 'fanout', {
      durable: true  // Exchange persiste após restart do RabbitMQ
    });

    // Adiciona ao cache
    exchangeCache.add(exchangeName);

    if (wasCached) {
      console.log(`✅ Exchange '${exchangeName}' revalidado com sucesso`);
    } else {
      console.log(`✅ Exchange '${exchangeName}' está pronto (criado ou já existia)`);
    }
    return true;

  } catch (error: unknown) {
    const err = error as Error;
    console.error(`❌ Erro ao garantir exchange '${exchangeName}':`, err.message);

    // Se der erro, remove do cache para tentar novamente depois
    exchangeCache.delete(exchangeName);

    return false;
  }
}

/**
 * Garante que a fila existe. Se não existir, cria automaticamente.
 * Se já existir, não faz nada (idempotente).
 *
 * @param {string} queueName - Nome da fila
 * @returns {Promise<boolean>} true se fila está pronta, false se houve erro
 */
async function ensureQueue(queueName: string): Promise<boolean> {
  try {
    if (!channel) {
      throw new Error('Canal RabbitMQ não disponível');
    }

    // Se ENABLE_CACHE_SKIP está ativo e fila está em cache, pula validação
    if (ENABLE_CACHE_SKIP && queueCache.has(queueName)) {
      console.log(`✓ Fila '${queueName}' já verificada anteriormente (cache ativo)`);
      return true;
    }

    const wasCached = queueCache.has(queueName);

    if (wasCached) {
      console.log(`🔍 Revalidando fila '${queueName}' (estava em cache)...`);
    } else {
      console.log(`🔍 Verificando se fila '${queueName}' existe...`);
    }

    // assertQueue é IDEMPOTENTE:
    // - Se a fila NÃO existe → CRIA
    // - Se a fila JÁ existe → NÃO FAZ NADA (apenas confirma)
    const queueInfo = await channel.assertQueue(queueName, {
      durable: true  // Fila persiste após restart do RabbitMQ
    });

    // Adiciona ao cache
    queueCache.add(queueName);

    if (wasCached) {
      console.log(`✅ Fila '${queueName}' revalidada com sucesso`);
    } else {
      console.log(`✅ Fila '${queueName}' está pronta (criada ou já existia)`);
    }
    console.log(`   📊 Info: ${queueInfo.messageCount} mensagens, ${queueInfo.consumerCount} consumidores`);
    return true;

  } catch (error: unknown) {
    const err = error as Error;
    console.error(`❌ Erro ao garantir fila '${queueName}':`, err.message);

    // Se der erro, remove do cache para tentar novamente depois
    queueCache.delete(queueName);

    return false;
  }
}

app.all('/webhook', async (req: Request, res: Response) => {
  try {
    // 1️⃣ VALIDAÇÃO: Token de autenticação
    const token = req.query.token;
    if (!token || token !== AUTH_TOKEN) {
      return res.status(401).json({
        success: false,
        error: 'Token de autenticação inválido ou ausente'
      });
    }

    // 2️⃣ VALIDAÇÃO: Nome do exchange ou fila
    const exchangeName = req.query.exchange as string | undefined;
    const queueName = req.query.queue as string | undefined;

    // Deve fornecer exchange OU queue, mas não ambos
    if (!exchangeName && !queueName) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetro "exchange" ou "queue" é obrigatório'
      });
    }

    if (exchangeName && queueName) {
      return res.status(400).json({
        success: false,
        error: 'Forneça apenas "exchange" OU "queue", não ambos'
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

    // 4️⃣ GARANTIR QUE EXCHANGE/FILA EXISTE (cria se não existir)
    const targetType = exchangeName ? 'exchange' : 'queue';
    const targetName = (exchangeName || queueName) as string;

    console.log(`\n📥 Webhook recebido - ${targetType}: '${targetName}'`);

    let isReady = false;
    if (exchangeName) {
      isReady = await ensureExchange(exchangeName);
    } else if (queueName) {
      isReady = await ensureQueue(queueName);
    }

    if (!isReady) {
      return res.status(500).json({
        success: false,
        error: `Não foi possível preparar ${targetType === 'exchange' ? 'o exchange' : 'a fila'} no RabbitMQ`,
        [targetType]: targetName
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

    // 6️⃣ PUBLICAR mensagem no exchange ou fila
    const message = Buffer.from(JSON.stringify(dataToSend));

    console.log(`📦 Preparando envio:`);
    console.log(`   📏 Tamanho: ${message.length} bytes`);
    console.log(`   🔑 Método: ${dataToSend.method}`);
    console.log(`   📋 Body keys: ${Object.keys(dataToSend.body || {}).join(', ') || 'vazio'}`);

    const messageOptions = {
      persistent: true,              // Mensagem sobrevive a restart do RabbitMQ
      contentType: 'application/json',
      timestamp: Date.now()
    };

    let sendSuccess = false;

    if (exchangeName) {
      // Publicar em exchange (fanout)
      console.log(`🚀 Publicando no exchange '${exchangeName}'...`);
      sendSuccess = channel.publish(exchangeName, '', message, messageOptions);
      if (sendSuccess) {
        console.log(`✅ Mensagem publicada com sucesso no exchange '${exchangeName}'`);
      } else {
        console.error(`❌ Falha ao enviar dados para exchange '${exchangeName}' - Buffer cheio`);
        throw new Error('Falha ao publicar mensagem no exchange - buffer cheio');
      }
    } else if (queueName) {
      // Enviar diretamente para fila (usando default exchange)
      console.log(`🚀 Enviando para fila '${queueName}'...`);
      sendSuccess = channel.sendToQueue(queueName, message, messageOptions);
      if (sendSuccess) {
        console.log(`✅ Mensagem enviada com sucesso para fila '${queueName}'`);
        console.log(`   ✓ Mensagem confirmada no buffer do canal`);
      } else {
        console.error(`❌ Falha ao enviar dados para fila '${queueName}' - Buffer cheio ou fila não existe`);
        throw new Error('Falha ao enviar mensagem para a fila - buffer cheio ou fila não existe');
      }
    }

    // 7️⃣ RESPONDER ao cliente
    const responseData: any = {
      success: true,
      message: 'Dados recebidos e enviados para RabbitMQ',
      timestamp: dataToSend.timestamp
    };

    if (exchangeName) {
      responseData.exchange = exchangeName;
    } else if (queueName) {
      responseData.queue = queueName;
    }

    res.status(200).json(responseData);

  } catch (error: unknown) {
    const err = error as Error;
    console.error('❌ Erro ao processar webhook:', err.message);

    // Se o erro for relacionado ao canal/conexão, limpa e agenda reconexão
    if (err.message.includes('Channel closed') ||
        err.message.includes('Connection closed') ||
        err.message.includes('Channel ended')) {
      channel = null;
      exchangeCache.clear();
      queueCache.clear();
      scheduleReconnect();
    }

    res.status(500).json({
      success: false,
      error: 'Erro ao processar webhook',
      details: err.message
    });
  }
});

app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    rabbitmq: channel ? 'connected' : 'disconnected',
    reconnectAttempts: reconnectAttempts,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    isReconnecting: isReconnecting,
    exchangesInCache: exchangeCache.size,
    queuesInCache: queueCache.size,
    timestamp: new Date().toISOString()
  });
});

// Endpoint de debug para testar conexão
app.get('/debug', async (req: Request, res: Response) => {
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
    queues: {
      cachedCount: queueCache.size,
      cached: Array.from(queueCache)
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
    console.log(`📍 Webhook (Exchange): http://localhost:${PORT}/webhook?exchange=NOME&token=TOKEN`);
    console.log(`📍 Webhook (Fila):     http://localhost:${PORT}/webhook?queue=NOME&token=TOKEN`);
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
  } catch (error: unknown) {
    const err = error as Error;
    console.error('❌ Erro ao fechar conexões:', err.message);
  }

  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error: Error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

start();
