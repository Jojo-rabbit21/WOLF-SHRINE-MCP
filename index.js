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

// 注册工具列表 (已修复：使用官方 Schema)
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

// 确保 Qdrant 集合存在并建好全文检索索引
async function ensureCollection() {
    try {
        const collections = await qdrant.getCollections();
        const exists = collections.collections.some(c => c.name === collectionName);
        if (!exists) {
            // 创建一个带虚拟向量的集合（Qdrant 要求至少有一个向量配置）
            await qdrant.createCollection(collectionName, {
                vectors: { size: 1, distance: "Cosine" }
            });
            // 为 content 字段创建全文检索索引
            await qdrant.createPayloadIndex(collectionName, {
                field_name: "content",
                field_schema: "text"
            });
        }
    } catch (e) {
        console.error("Failed to initialize collection", e);
    }
}

// 处理工具调用 (已修复：使用官方 Schema)
server.setRequestHandler(
  CallToolRequestSchema,
  async (request) => {
    await ensureCollection();
    const { name, arguments: args } = request.params;

    if (name === "store_memory") {
      const id = Math.floor(Math.random() * 10000000);
      await qdrant.upsert(collectionName, {
          wait: true,
          points: [
              {
                  id: id,
                  vector: [0.0], // 虚拟向量
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
      // 触发 Qdrant 强大的全文检索功能
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

    throw new Error(`Unknown tool: ${name}`);
  }
);

// SSE 传输端点配置
let transport;
app.use(express.json());

app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  if (transport) {
    await transport.handleMessage(req, res);
  } else {
    res.status(400).send("No active SSE session");
  }
});

app.listen(port, () => {
  console.log(`Shrine MCP server running on port ${port}`);
});
