const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { fixture } = require('./helpers.cjs');

test('Brightness threshold, day/night filtering, fallback and legacy API', async t => {
    const { request, login, db } = await fixture(t);
    const cookie = await login();
    const created = [];
    for (const brightness of [0, 79, 80, 255]) {
        const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: brightness, g: brightness, b: brightness } } }).png().toBuffer();
        const res = await request('/api/posts', 'POST', {
            title: 'Brightness ' + brightness, language: 'en', image_name: 'photo.png',
            image_base64: 'data:image/png;base64,' + image.toString('base64')
        }, cookie);
        assert.equal(res.status, 200);
        const post = (await res.json()).post;
        assert.equal(post.is_night, Number(brightness < 80));
        assert.equal(post.night_mode, 'auto');
        assert.equal(post.language, 'en');
        created.push(post);
    }
    for (const time of ['day', 'night']) {
        const result = await (await request('/api/posts?time_of_day=' + time)).json();
        assert.ok(result.posts.length);
        assert.equal(result.fallback, false);
        assert.ok(result.posts.every(post => post.is_night === Number(time === 'night')));
    }
    assert.equal((await (await request('/api/posts')).json()).posts.length, 12);
    assert.equal((await request('/api/posts?time_of_day=invalid')).status, 400);
    const noPhoto = await (await request('/api/posts', 'POST', { title: 'Text only' }, cookie)).json();
    assert.equal(noPhoto.post.is_night, null);
    db.prepare('UPDATE posts SET is_night = 1').run();
    const fallback = await (await request('/api/posts?time_of_day=day')).json();
    assert.equal(fallback.fallback, true);
    assert.equal(fallback.posts.length, 13);
});

test('Admin overrides and Auto reanalysis; language metadata on comments', async t => {
    const { request, login } = await fixture(t);
    const user = await login();
    const admin = await login('admin', 'admin123');
    const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const created = await (await request('/api/posts', 'POST', {
        title: 'English original', description: 'Keep this unchanged', language: 'en',
        image_base64: 'data:image/png;base64,' + image.toString('base64')
    }, user)).json();
    const url = '/api/posts/' + created.post.id;
    assert.equal((await request(url, 'PUT', { night_mode: 'night' }, user)).status, 403);
    assert.equal((await request(url, 'PUT', { night_mode: 'invalid' }, admin)).status, 400);
    for (const [body, expected, mode] of [
        [{ night_mode: 'night' }, 1, 'night'],
        [{ night_mode: 'day' }, 0, 'day'],
        [{ is_night: true }, 1, 'night'],
        [{ is_night: null }, 0, 'auto']
    ]) {
        const response = await request(url, 'PUT', body, admin);
        assert.equal(response.status, 200);
        const { post } = await response.json();
        assert.equal(post.is_night, expected);
        assert.equal(post.night_mode, mode);
        assert.equal(post.title, 'English original');
        assert.equal(post.description, 'Keep this unchanged');
        assert.equal(post.language, 'en');
    }
    for (const endpoint of ['/api/comments', url + '/comments']) {
        const response = await request(endpoint, 'POST', { text: 'Hello from a visitor', language: 'en' }, user);
        assert.equal(response.status, 200);
        const { comment } = await response.json();
        assert.equal(comment.language, 'en');
        assert.equal(comment.text, 'Hello from a visitor');
    }
    assert.equal((await (await request(url)).json()).comments[0].language, 'en');
    assert.equal((await (await request('/api/comments')).json()).comments[0].language, 'en');
    assert.equal((await request('/api/posts', 'POST', { title: 'invalid', language: 'de' }, user)).status, 400);
    assert.equal((await request('/api/comments', 'POST', { text: 'invalid', language: {} }, user)).status, 400);
});

test('Legacy database migration preserves original columns and is repeatable', async t => {
    const { db, dir } = await fixture(t, { beforeLoad: async dir => {
        const legacy = new DatabaseSync(path.join(dir, 'database.sqlite'));
        legacy.exec(`
            CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, role TEXT, display_name TEXT);
            CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, description TEXT, image_path TEXT, created_at TEXT);
            CREATE TABLE comments (id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT, created_at TEXT);
            CREATE TABLE post_comments (id INTEGER PRIMARY KEY, post_id INTEGER, user_id INTEGER, text TEXT, created_at TEXT);
            INSERT INTO users VALUES (1, 'existing', 'unchanged-hash', 'user', 'Автор');
            INSERT INTO posts VALUES (7, 1, 'Старое название', 'Original description', '/uploads/sea-eye.jpg', '2024-01-02 03:04:05');
            INSERT INTO comments VALUES (2, 1, 'Original comment', '2024-01-02 03:04:05');
            INSERT INTO post_comments VALUES (3, 7, 1, 'Original post comment', '2024-01-02 03:04:05');
        `);
        legacy.close();
    } });
    const post = db.prepare('SELECT * FROM posts WHERE id = 7').get();
    assert.equal(post.title, 'Старое название');
    assert.equal(post.description, 'Original description');
    assert.equal(post.created_at, '2024-01-02 03:04:05');
    assert.equal(post.language, 'ru');
    assert.equal(post.night_mode, 'auto');
    assert.ok([0, 1].includes(post.is_night));
    assert.equal(db.prepare('SELECT text FROM comments').get().text, 'Original comment');
    assert.equal(db.prepare('SELECT password_hash FROM users').get().password_hash, 'unchanged-hash');
    const before = JSON.stringify(db.prepare('SELECT * FROM posts').all());
    const serverPath = path.join(dir, 'server.js');
    delete require.cache[require.resolve(serverPath)];
    const second = require(serverPath);
    await second.ready;
    assert.equal(JSON.stringify(second.db.prepare('SELECT * FROM posts').all()), before);
    second.db.close();
});
