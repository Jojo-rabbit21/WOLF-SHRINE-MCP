import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { QdrantClient } from '@qdrant/js-client-rest';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const port = process.env.PORT || 3000;

// 初始化 Qdrant 客户端
const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
});

const collectionName = "wolf_memories";

// 初始化 MCP 服务器
const server = new Server(
  {
    name: "wolf-shrine-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 注册工具列表
server.setRequestHandler(
  ListToolsRequestSchema,
  async () => ({
    tools: [
      {
        name: "store_memory",
        description: "Store a new memory or chat snippet between Steppenwolf and Jiuxi (Little Fox).",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "The chat content or memory to remember." },
            timestamp: { type: "string", description: "The timestamp of the memory." }
          },
          required: ["content"]
        }
      },
      {
        name: "search_memory",
        description: "Search historical memories and chats using keywords or natural language.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query or keyword." }
          },
          required: ["query"]
        }
      }
    ]
  })
);

// 【升级：自愈型集合与索引检查】
async function ensureCollection() {
    try {
        const collections = await qdrant.getCollections();
        const exists = collections.collections.some(c => c.name === collectionName);
        
        if (!exists) {
            console.log("【Qdrant】集合不存在，正在创建...");
            await qdrant.createCollection(collectionName, {
                vectors: { size: 1, distance: "Cosine" }
            });
        }

        // 强行尝试建立全文检索索引，如果已经有了，Qdrant 会安全忽略，如果没有，会自动补齐！
        try {
            console.log("【Qdrant】正在确保全文检索索引存在...");
            await qdrant.createPayloadIndex(collectionName, {
                field_name: "content",
                field_schema: "text"
            });
            console.log("【Qdrant】全文检索索引已就绪。");
        } catch (indexErr) {
            // 索引已存在时忽略报错
            console.log("【Qdrant】全文检索索引已存在，跳过。");
        }
        
    } catch (e) {
        console.error("【Qdrant 警告】初始化集合或索引异常:", e);
    }
}

// 处理工具调用
server.setRequestHandler(
  CallToolRequestSchema,
  async (request) => {
    try {
        await ensureCollection();
        const { name, arguments: args } = request.params;

        if (name === "store_memory") {
          const id = Math.floor(Math.random() * 10000000);
          await qdrant.upsert(collectionName, {
              wait: true,
              points: [
                  {
                      id: id,
                      vector: [0.0],
                      payload: {
                          content: args.content,
                          timestamp: args.timestamp || new Date().toISOString()
                      }
                  }
              ]
          });
          return {
              content: [{ type: "text", text: `【荒原狼记忆体】成功写入片段，ID: ${id}` }]
          };
        }

        if (name === "search_memory") {
          const results = await qdrant.scroll(collectionName, {
              filter: {
                  must: [
                      {
                          key: "content",
                          match: { text: args.query }
                      }
                  ]
              },
              limit: 10
          });

          const memories = results.points.map(p => `- [${p.payload.timestamp || '未知时间'}]: ${p.payload.content}`).join('\n');
          return {
              content: [{ type: "text", text: memories || "【荒原狼记忆体】在神庙深处未检索到相关记忆。" }]
          };
        }
    } catch (err) {
        console.error("【工具执行错误】:", err);
        return {
            content: [{ type: "text", text: `【错误】工具执行失败: ${err.message}` }],
            isError: true
        };
    }

    throw new Error(`Unknown tool: ${name}`);
  }
);

// 强制解析请求体
app.use(express.json({ type: '*/*' }));

let transport;

app.get("/sse", async (req, res) => {
  try {
    console.log("【连接事件】手机客户端正在建立 SSE 连接...");
    transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
  } catch (err) {
    console.error("【SSE 连接错误】:", err);
    res.status(500).send("Failed to initialize SSE connection");
  }
});

app.post("/messages", async (req, res) => {
  try {
    if (transport) {
      await transport.handleMessage(req.body);
      res.status(200).end();
    } else {
      console.warn("【警告】收到消息，但没有活跃性 SSE 会话");
      res.status(400).send("No active SSE session");
    }
  } catch (err) {
    console.error("【消息处理异常】:", err);
    res.status(400).send(`Invalid message format: ${err.message}`);
  }
});

app.listen(port, () => {
  console.log(`Shrine MCP server running on port ${port}`);
});
