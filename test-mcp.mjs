import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "java-inspector",
  args: [],
  env: { ...process.env, NODE_ENV: "production" }
});

const client = new Client({ name: "test-client", version: "1.0.0" });

try {
  await client.connect(transport);
  console.log("[TEST] Connected to java-inspector");

  const tools = await client.listTools();
  console.log("[TEST] Available tools:", tools.tools.map(t => t.name));

  console.log("[TEST] Calling scan_dependencies...");
  const scanResult = await client.callTool({
    name: "scan_dependencies",
    arguments: { projectPath: "/workspace/spring-ai" }
  });
  console.log("[TEST] scan_dependencies result:", JSON.stringify(scanResult, null, 2));

  // Wait for Maven classpath resolution and some scanning
  console.log("[TEST] Waiting 90s for background scan...");
  await new Promise(r => setTimeout(r, 90000));

  console.log("[TEST] Calling search_class for 'Logger'...");
  const searchResult = await client.callTool({
    name: "search_class",
    arguments: { projectPath: "/workspace/spring-ai", query: "Logger" }
  });
  console.log("[TEST] search_class result:", JSON.stringify(searchResult, null, 2));

  // Try analyze_class on a known class if found
  const text = searchResult.content?.[0]?.text || "";
  if (text.includes("org.slf4j.Logger")) {
     console.log("[TEST] Calling analyze_class for org.slf4j.Logger...");
     const analyzeResult = await client.callTool({
       name: "analyze_class",
       arguments: { projectPath: "/workspace/spring-ai", className: "org.slf4j.Logger" }
     });
     console.log("[TEST] analyze_class result:", JSON.stringify(analyzeResult, null, 2));
  } else {
     console.log("[TEST] org.slf4j.Logger not found in search results, skipping analyze_class");
  }
} catch (e) {
  console.error("[TEST] Error:", e.message);
} finally {
  await client.close();
}
