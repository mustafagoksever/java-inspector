import { Command } from 'commander';
import { createRequire } from 'module';
import { JavaClassAnalyzerMCPServer } from './index.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
    .name('java-inspector')
    .description('Java Inspector MCP - MCP server that gives AI agents instant access to decompiled Java code.')
    .version(version);

program
    .command('start')
    .description('Start MCP server')
    .option('-e, --env <environment>', 'Runtime environment (development|production)', 'production')
    .action(async (options) => {
        // Set environment variables
        if (options.env) {
            process.env.NODE_ENV = options.env;
        }

        console.log(`Starting Java Class Analyzer MCP Server (${options.env} mode)...`);

        const server = new JavaClassAnalyzerMCPServer();
        await server.run();
    });

program
    .command('test')
    .description('Test MCP server functionality')
    .option('-p, --project <path>', 'Maven project path')
    .option('-c, --class <className>', 'Class name to test')
    .option('--no-cache', 'Do not use cache')
    .option('--decompiler-path <path>', 'Vineflower decompiler JAR path')
    .action(async (options) => {
console.log('Test mode - please use test-tools.js for complete testing');
        console.log('Run: node test-tools.js --help for detailed usage');
    });

program
    .command('config')
    .description('Generate MCP client configuration example')
    .option('-o, --output <file>', 'Output configuration file path', 'mcp-client-config.json')
    .action(async (options) => {
        const config = {
            mcpServers: {
                "java-inspector": {
                    command: "java-inspector",
                    args: ["start"],
                    env: {
                        NODE_ENV: "production",
                        MAVEN_REPO: process.env.MAVEN_REPO || "",
                        JAVA_HOME: process.env.JAVA_HOME || "",
                        DECOMPILER_PATH: process.env.DECOMPILER_PATH || ""
                    }
                }
            }
        };

        const fs = await import('fs-extra');
        await fs.default.writeJson(options.output, config, { spaces: 2 });
console.log(`MCP client configuration generated: ${options.output}`);
        console.log('\nUsage instructions:');
        console.log('1. Add this configuration to your MCP client configuration file');
        console.log('2. Modify environment variable settings as needed');
        console.log('3. Restart MCP client');
    });

// Default command
if (process.argv.length === 2) {
    // If no subcommand provided, start server by default
    process.env.NODE_ENV = process.env.NODE_ENV || 'production';
    const server = new JavaClassAnalyzerMCPServer();
    server.run().catch((error) => {
        console.error('Server startup failed:', error);
        process.exit(1);
    });
} else {
    program.parse();
}
