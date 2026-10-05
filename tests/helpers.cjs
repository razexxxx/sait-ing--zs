const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

async function fixture(t, options = {}) {
    // Каждый тест использует собственную БД, фотографии и лимиты запросов.
    const parent = path.join(root, '.test-work');
    fs.mkdirSync(parent, { recursive: true });
    const dir = fs.mkdtempSync(path.join(parent, 'security-'));
    fs.copyFileSync(path.join(root, 'server.js'), path.join(dir, 'server.js'));
    fs.cpSync(path.join(root, 'public'), path.join(dir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), 'SESSION_SECRET=test-secret-with-at-least-32-characters\nNODE_ENV=development\n');
    fs.writeFileSync(path.join(dir, 'cookie.txt'), 'private-test-cookie');
    if (options.beforeLoad) await options.beforeLoad(dir);
    const { app, db, ready } = require(path.join(dir, 'server.js'));
    await ready;
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        db.close();
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(url, method = 'GET', body, cookie) {
        return fetch(base + url, { method, headers: {
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(cookie ? { Cookie: cookie } : {})
        }, body: body === undefined ? undefined : JSON.stringify(body) });
    }
    async function login(username = 'user1', password = 'user123') {
        const res = await request('/api/login', 'POST', { username, password });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('set-cookie'), /HttpOnly/);
        return res.headers.get('set-cookie').split(';')[0];
    }
    return { request, login, db, dir };
}

module.exports = { fixture };
