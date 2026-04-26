#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'dist', 'index.js');
const child = spawn(process.execPath, [indexPath], {
  stdio: 'inherit',
  windowsHide: true
});

child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
