"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vite_1 = require("vite");
const plugin_react_1 = require("@vitejs/plugin-react");
const path_1 = require("path");
exports.default = (0, vite_1.defineConfig)({
    root: 'renderer',
    plugins: [(0, plugin_react_1.default)()],
    resolve: {
        alias: { '@': (0, path_1.resolve)(__dirname, 'renderer/src') },
    },
    build: {
        outDir: (0, path_1.resolve)(__dirname, 'dist/renderer'),
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        strictPort: true,
    },
});
