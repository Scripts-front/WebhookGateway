# Webhook Gateway

Gateway para receber webhooks via HTTP e enviá-los para o RabbitMQ. Cada webhook é publicado em um exchange específico configurável via query parameter.

## Instalação

Instale as dependências:

```bash
bun install
```

## Configuração

Crie um arquivo `.env` na raiz do projeto:

```env
PORT=3000
RABBITMQ_URL=amqp://usuario:senha@localhost:5672
RABBITMQ_VHOST=/nome-do-vhost
AUTH_TOKEN=seu-token-secreto
MAX_RECONNECT_ATTEMPTS=10
```

### Variáveis de Ambiente

| Variável | Obrigatório | Padrão | Descrição |
|----------|-------------|--------|-----------|
| `PORT` | Não | 3000 | Porta onde a API vai rodar |
| `RABBITMQ_URL` | Sim | - | URL de conexão do RabbitMQ (formato: `amqp://user:pass@host:port`) |
| `RABBITMQ_VHOST` | Não | `/` | Virtual host do RabbitMQ |
| `AUTH_TOKEN` | Sim | - | Token de autenticação para proteger a API |
| `MAX_RECONNECT_ATTEMPTS` | Não | 10 | Número máximo de tentativas de reconexão ao RabbitMQ |

## Executar

```bash
bun run index.ts
```

Ou com Docker:

```bash
docker build -t webhook-gateway .
docker run -p 3000:3000 --env-file .env webhook-gateway
```

## Uso da API

### Endpoint: `/webhook`

Recebe webhooks e publica no RabbitMQ.

**Métodos suportados:** `GET`, `POST`, `PUT`, `PATCH`, `DELETE`

**Query Parameters obrigatórios:**
- `exchange` (string) **OU** `queue` (string):
  - `exchange`: Nome do exchange no RabbitMQ (tipo fanout - envia para todas as filas vinculadas)
  - `queue`: Nome da fila no RabbitMQ (envio direto, ponto-a-ponto)
  - **Atenção:** Forneça apenas um dos dois, não ambos
- `token` (string): Token de autenticação (deve corresponder ao `AUTH_TOKEN` do `.env`)

#### Exemplos de Uso

**POST com JSON (para Exchange):**
```bash
curl -X POST "http://localhost:3000/webhook?exchange=meu-exchange&token=seu-token-secreto" \
  -H "Content-Type: application/json" \
  -d '{"evento": "compra", "valor": 100.50, "usuario_id": 123}'
```

**POST com JSON (para Fila):**
```bash
curl -X POST "http://localhost:3000/webhook?queue=minha-fila&token=seu-token-secreto" \
  -H "Content-Type: application/json" \
  -d '{"evento": "compra", "valor": 100.50, "usuario_id": 123}'
```

**POST com Form Data:**
```bash
curl -X POST "http://localhost:3000/webhook?exchange=formularios&token=seu-token-secreto" \
  -F "nome=João Silva" \
  -F "email=joao@example.com" \
  -F "arquivo=@documento.pdf"
```

**GET com Query Params (para Fila):**
```bash
curl "http://localhost:3000/webhook?queue=eventos&token=seu-token-secreto&evento=click&pagina=home"
```

#### Resposta de Sucesso (200)

**Quando enviado para Exchange:**
```json
{
  "success": true,
  "message": "Dados recebidos e enviados para RabbitMQ",
  "exchange": "meu-exchange",
  "timestamp": "2025-03-13T10:30:45.123Z"
}
```

**Quando enviado para Fila:**
```json
{
  "success": true,
  "message": "Dados recebidos e enviados para RabbitMQ",
  "queue": "minha-fila",
  "timestamp": "2025-03-13T10:30:45.123Z"
}
```

#### Estrutura da Mensagem Enviada ao RabbitMQ

Os dados enviados ao RabbitMQ incluem informações completas sobre a requisição:

```json
{
  "timestamp": "2025-03-13T10:30:45.123Z",
  "method": "POST",
  "params": {
    "evento": "click",
    "pagina": "home"
  },
  "body": {
    "usuario_id": 123,
    "valor": 100.50
  },
  "headers": {
    "content-type": "application/json",
    "user-agent": "curl/7.81.0"
  },
  "ip": "::1",
  "path": "/webhook",
  "originalUrl": "/webhook?exchange=meu-exchange&token=XXX"
}
```

#### Erros Comuns

**401 - Token inválido:**
```json
{
  "success": false,
  "error": "Token de autenticação inválido ou ausente"
}
```

**400 - Exchange/Queue não informado:**
```json
{
  "success": false,
  "error": "Parâmetro \"exchange\" ou \"queue\" é obrigatório"
}
```

**400 - Ambos informados:**
```json
{
  "success": false,
  "error": "Forneça apenas \"exchange\" OU \"queue\", não ambos"
}
```

**503 - RabbitMQ desconectado:**
```json
{
  "success": false,
  "error": "RabbitMQ não está conectado. Tentando reconectar...",
  "reconnectAttempt": 2,
  "maxAttempts": 10
}
```

### Endpoint: `/health`

Verifica o status da aplicação e da conexão com o RabbitMQ.

```bash
curl http://localhost:3000/health
```

**Resposta:**
```json
{
  "status": "ok",
  "rabbitmq": "connected",
  "reconnectAttempts": 0,
  "maxAttempts": 10,
  "isReconnecting": false,
  "exchangesInCache": 2,
  "queuesInCache": 3,
  "timestamp": "2025-03-13T10:30:45.123Z"
}
```

### Endpoint: `/debug`

Informações detalhadas para debug (útil para troubleshooting).

```bash
curl http://localhost:3000/debug
```

**Resposta:**
```json
{
  "env": {
    "RABBITMQ_URL_SET": true,
    "RABBITMQ_VHOST": "meu-vhost",
    "AUTH_TOKEN_SET": true,
    "MAX_RECONNECT_ATTEMPTS": 10
  },
  "connection": {
    "isConnected": true,
    "reconnectAttempts": 0,
    "isReconnecting": false,
    "hasReconnectTimer": false
  },
  "exchanges": {
    "cachedCount": 2,
    "cached": ["meu-exchange", "formularios"]
  },
  "queues": {
    "cachedCount": 1,
    "cached": ["minha-fila"]
  },
  "timestamp": "2025-03-13T10:30:45.123Z"
}
```

## Exchange vs Fila: Quando usar?

### Usar `exchange` quando:
- **Múltiplos consumidores:** Várias aplicações precisam receber a mesma mensagem
- **Broadcast:** Modelo pub/sub (1 produtor, N consumidores)
- **Flexibilidade:** Consumidores podem ser adicionados/removidos dinamicamente
- **Exemplo:** Notificações, eventos de sistema, logs

### Usar `queue` quando:
- **Consumidor único:** Apenas uma aplicação processa a mensagem
- **Ponto-a-ponto:** Modelo de fila tradicional (1 produtor, 1 consumidor)
- **Simplicidade:** Não precisa de configuração de bindings
- **Exemplo:** Processamento de tarefas, jobs, filas de trabalho

## Comportamento do RabbitMQ

### Exchanges

- **Tipo:** Fanout (envia para todas as filas conectadas ao exchange)
- **Durável:** Sim (persiste após restart do RabbitMQ)
- **Auto-criação:** Se o exchange não existir, será criado automaticamente
- **Nota:** Requer filas vinculadas (bound) para armazenar mensagens

### Filas

- **Tipo:** Direct (envio direto usando default exchange)
- **Durável:** Sim (persiste após restart do RabbitMQ)
- **Auto-criação:** Se a fila não existir, será criada automaticamente
- **Vantagem:** Mensagens são armazenadas imediatamente, sem necessidade de bindings

### Mensagens

- **Persistência:** Sim (mensagens sobrevivem a restart do RabbitMQ)
- **Content-Type:** `application/json`
- **Encoding:** UTF-8

### Reconexão Automática

A aplicação tenta reconectar automaticamente ao RabbitMQ em caso de falha:
- Intervalo entre tentativas: 5 segundos
- Máximo de tentativas: configurável via `MAX_RECONNECT_ATTEMPTS`
- Se atingir o máximo de tentativas, a aplicação é encerrada

## Segurança

- **Autenticação:** Toda requisição ao `/webhook` requer o parâmetro `token` na query string
- **Validação:** O token é validado antes de processar qualquer webhook
- **HTTPS:** Recomendado usar HTTPS em produção (configurar via proxy reverso como Nginx)

## Troubleshooting

### RabbitMQ não conecta

Verifique se o RabbitMQ está rodando:
```bash
docker ps | grep rabbitmq
# ou
sudo systemctl status rabbitmq-server
```

Teste a URL de conexão:
```bash
curl http://usuario:senha@localhost:15672/api/overview
```

### Exchange não é criado

Verifique as permissões do usuário no RabbitMQ:
```bash
rabbitmqctl list_permissions -p /nome-do-vhost
```

O usuário precisa ter permissões de `configure`, `write` e `read` no vhost.

### Logs úteis

A aplicação exibe logs detalhados no console:
- Tentativas de conexão ao RabbitMQ
- Criação de exchanges
- Processamento de webhooks
- Erros e reconexões

## Tecnologias

- [Bun](https://bun.com) - Runtime JavaScript
- [Express](https://expressjs.com) - Framework web
- [amqplib](https://amqp-node.github.io/amqplib/) - Cliente RabbitMQ
