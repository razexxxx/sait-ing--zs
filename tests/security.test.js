const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');

const { fixture } = require('./helpers.cjs');

test('Public files, existing API and private file isolation', async t => {
    const { request, login } = await fixture(t);
    for (const url of ['/', '/app.js', '/styles.css', '/image/sea-eye.jpg', '/uploads/sea-eye.jpg']) {
        const res = await request(url);
        assert.equal(res.status, 200, url);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
    for (const url of ['/database.sqlite', '/server.js', '/cookie.txt', '/.env', '/package.json', '/node_modules/express/package.json', '/uploads/../database.sqlite', '/%2e%2e/database.sqlite']) {
        assert.equal((await request(url)).status, 404, url);
    }
    const posts = await (await request('/api/posts')).json();
    assert.equal(posts.posts.length, 8);
    assert.equal((await request('/api/posts/1')).status, 200);
    assert.equal((await request('/api/posts/99999')).status, 404);
    assert.equal((await request('/api/comments', 'POST', { text: 'test' })).status, 401);
    const registered = await request('/api/register', 'POST', { username: 'new-user', password: 'test-password' });
    assert.equal(registered.status, 200);
    const cookie = await login();
    assert.equal((await request('/api/users', 'GET', undefined, cookie)).status, 403);
    assert.equal((await request('/api/me', 'GET', undefined, cookie)).status, 200);
    assert.equal((await request('/api/logout', 'POST', {}, cookie)).status, 200);
    assert.equal((await (await request('/api/me', 'GET', undefined, cookie)).json()).user, null);
});

test('Image validation, sanitizing, backward compatibility, edit and delete', async t => {
    const { request, login, dir } = await fixture(t);
    const cookie = await login();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00aa55' } }).png().toBuffer();
    const jpeg = await sharp(png).jpeg().toBuffer();
    const data = (buffer, format = 'png') => `data:image/${format};base64,${buffer.toString('base64')}`;
    const invalid = [
        { image_base64: data(png), image_name: 'bad.exe' },
        { image_base64: data(png), image_name: 'bad.js' },
        { image_base64: data(png), image_name: 'bad.jpg' },
        { image_base64: data(Buffer.from('<script>alert(1)</script>')) },
        { image_base64: data(png, 'jpeg') },
        { image_base64: data(png.subarray(0, 40)) }
    ];
    for (const item of invalid) assert.equal((await request('/api/posts', 'POST', { title: 'invalid', ...item }, cookie)).status, 400);
    assert.equal((await request('/api/posts', 'POST', { title: 'too big', image_base64: data(Buffer.alloc(5 * 1024 * 1024 + 1)) }, cookie)).status, 413);
    const pngRes = await request('/api/posts', 'POST', { title: 'PNG', image_base64: data(Buffer.concat([png, Buffer.from('TRAILING_PAYLOAD')])), image_name: 'photo.png' }, cookie);
    assert.equal(pngRes.status, 200);
    const post = (await pngRes.json()).post;
    const saved = fs.readFileSync(path.join(dir, 'public', post.image_path));
    assert.equal(saved.includes(Buffer.from('TRAILING_PAYLOAD')), false);
    assert.equal((await sharp(saved).metadata()).format, 'png');
    assert.equal((await request('/api/posts', 'POST', { title: 'JPEG legacy', image_base64: data(jpeg, 'jpeg') }, cookie)).status, 200);
    assert.equal((await request('/api/posts', 'POST', { title: 'No image' }, cookie)).status, 200);
    const admin = await login('admin', 'admin123');
    assert.equal((await request(`/api/posts/${post.id}`, 'PUT', { title: 'Edited' }, admin)).status, 200);
    assert.equal((await request(`/api/posts/${post.id}`, 'DELETE', undefined, admin)).status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'public', post.image_path)), false);
});

test('Active sessions are revoked after a ban, expired bans allow access', async t => {
    const { request, login, db } = await fixture(t);
    const cookie = await login();
    const admin = await login('admin', 'admin123');
    assert.equal((await request('/api/bans', 'POST', { user_id: 2, reason: 'test' }, admin)).status, 200);
    const res = await request('/api/comments', 'POST', { text: 'blocked' }, cookie);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).banned, true);
    assert.equal((await request('/api/posts', 'POST', { title: 'blocked' }, cookie)).status, 401);
    const bans = await (await request('/api/bans', 'GET', undefined, admin)).json();
    assert.equal((await request(`/api/bans/${bans.bans[0].id}`, 'DELETE', undefined, admin)).status, 200);
    const fresh = await login();
    db.prepare("INSERT INTO bans (user_id, reason, banned_by, expires_at) VALUES (2, 'expired', 1, datetime('now', '-1 minute'))").run();
    assert.equal((await request('/api/comments', 'POST', { text: 'allowed' }, fresh)).status, 200);
    assert.equal((await request('/api/posts/1/comments', 'POST', { text: 'allowed' }, fresh)).status, 200);
    db.prepare("INSERT INTO bans (user_id, reason, banned_by) VALUES (2, 'new ban', 1)").run();
    assert.equal((await request('/api/me', 'GET', undefined, fresh)).status, 403);
});

test('Creation limit is shared by posts and both comment types', async t => {
    const { request, login } = await fixture(t);
    const cookie = await login();
    for (let i = 0; i < 10; i++) {
        const url = i % 3 === 0 ? '/api/posts' : i % 3 === 1 ? '/api/comments' : '/api/posts/1/comments';
        assert.equal((await request(url, 'POST', { title: 'test', text: 'test' }, cookie)).status, 200);
    }
    const res = await request('/api/posts', 'POST', { title: 'limited' }, cookie);
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('retry-after'));
    assert.match((await res.json()).error, /10/);
});

test('Authentication limit: sixth attempt is denied across login/register', async t => {
    const { request } = await fixture(t);
    for (let i = 0; i < 5; i++) assert.equal((await request('/api/login', 'POST', { username: 'no-user', password: 'wrong' })).status, 401);
    assert.equal((await request('/api/register', 'POST', { username: 'limited-user', password: 'password' })).status, 429);
});

test('General limit: request 101 is denied including static requests', async t => {
    const { request } = await fixture(t);
    for (let i = 0; i < 100; i++) assert.equal((await request('/api/me')).status, 200);
    const res = await request('/styles.css');
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('retry-after'));
});
