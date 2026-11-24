// Manual smoke test against the built server: `npm run build && node test-mcp.mjs [workspacePath]`
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";

const workspacePath = path.resolve(process.argv[2] ?? process.cwd());
const jarPath = path.resolve("lib/vineflower-1.11.2.jar");
const className = "org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler";

const transport = new StdioClientTransport({
  command: "node",
  args: [path.resolve("dist/cli.js")],
  cwd: workspacePath,
  env: { ...process.env, NODE_ENV: "production" },
});
const client = new Client({ name: "test-client", version: "1.0.0" });

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map(item => item.text).join("\n");
  console.log(`\n[TEST] ${name} isError=${Boolean(result.isError)}\n${text.slice(0, 800)}`);
  return result;
};

try {
  await client.connect(transport);
  console.log("[TEST] Instructions:", client.getInstructions()?.split("\n")[0]);
  console.log("[TEST] Tools:", (await client.listTools()).tools.map(tool => tool.name).join(", "));

  await call("scan_project", { workspacePath });
  await call("search_class", { query: "ConsoleDecompiler", jarPath });
  await call("inspect_class", { className, jarPath, view: "api" });
  await call("inspect_class", { className, jarPath, view: "source", offset: 1, limit: 40 });
  await call("inspect_class", { className: "java.util.ArrayList", view: "hierarchy" });
  await call("search_code", { query: "decompileContext", kind: "method", jarPath });
  await call("search_resources", { jarPath, pathQuery: "META-INF" });
} finally {
  await client.close();
}
