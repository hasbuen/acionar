import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4173);
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
    || process.env.SUPABASE_ANON_KEY
    || '';

if (!supabaseUrl || !supabaseKey) {
    console.error('Defina SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY no arquivo .env.');
    process.exit(1);
}

const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.webp': 'image/webp'
};

function injectLocalEnvironment(content) {
    return content
        .split('__SUPABASE_URL__').join(supabaseUrl)
        .split('__SUPABASE_ANON_KEY__').join(supabaseKey);
}

function safePath(url) {
    const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const fullPath = resolve(projectRoot, relativePath);
    if (fullPath !== projectRoot && !fullPath.startsWith(`${projectRoot}${sep}`)) return null;
    return fullPath;
}

const server = createServer(async (request, response) => {
    try {
        let filePath = safePath(request.url || '/');
        if (!filePath) {
            response.writeHead(403).end('Acesso negado');
            return;
        }

        const fileStat = await stat(filePath);
        if (fileStat.isDirectory()) filePath = resolve(filePath, 'index.html');

        const extension = extname(filePath).toLowerCase();
        let content = await readFile(filePath);
        if (extension === '.html' || extension === '.js' || extension === '.mjs') {
            content = Buffer.from(injectLocalEnvironment(content.toString('utf8')), 'utf8');
        }

        response.writeHead(200, {
            'Content-Type': mimeTypes[extension] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(content);
    } catch (error) {
        const statusCode = error?.code === 'ENOENT' ? 404 : 500;
        response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(statusCode === 404 ? 'Arquivo não encontrado' : 'Erro no servidor local');
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Acionar local: http://127.0.0.1:${port}`);
    console.log('Credenciais carregadas do .env apenas em memória.');
});
