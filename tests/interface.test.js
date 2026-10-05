const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function interfaceFixture({ storage = new Map(), user = null, storageBlocked = false } = {}) {
    const { document, window } = parseHTML(html);
    // linkedom provides a DOM, not a browser; fill in the missing form APIs.
    const selectPrototype = window.HTMLSelectElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(selectPrototype, 'value');
    if (!descriptor.set) Object.defineProperty(selectPrototype, 'value', {
        configurable: true, get: descriptor.get,
        set(value) {
            for (const option of this.querySelectorAll('option')) option.removeAttribute('selected');
            const option = [...this.querySelectorAll('option')].find(option => option.value === value);
            if (option) option.setAttribute('selected', '');
        }
    });
    document.querySelectorAll('form').forEach(form => { form.reset = () => {};
    });
    Object.defineProperty(document.getElementById('post-image'), 'files', { value: [], writable: true });
    const requests = [];
    const timers = [];
    const errors = [];
    const clock = { hour: 12 };
    const post = { id: 1, title: 'Author title', description: 'Original description', language: 'en', image_path: '/uploads/sea-eye.jpg', created_at: '2026-01-02 03:04:05', display_name: 'Visitor', username: 'visitor', role: 'user', is_night: 0, night_mode: 'auto' };
    const comment = { id: 1, text: 'Original comment', language: 'en', display_name: 'Visitor', username: 'visitor', role: 'user', created_at: '2026-01-02 03:04:05' };
    const context = vm.createContext({
        document, window: { matchMedia: () => ({ matches: true }) },
        Date: class extends Date { getHours() { return clock.hour; } },
        localStorage: {
            getItem(key) { if (storageBlocked) throw new Error('Blocked'); return storage.get(key); },
            setItem(key, value) { if (storageBlocked) throw new Error('Blocked'); storage.set(key, value); }
        },
        console: { error: (...args) => errors.push(args), log() {} },
        setInterval(callback, ms) { timers.push({ callback, ms }); },
        alert: message => errors.push(message), confirm: () => true,
        fetch: async (url, options = {}) => {
            requests.push({ url, ...options });
            let data = {};
            if (url === '/api/me') data = { user };
            else if (url === '/api/comments') data = options.method === 'POST' ? { comment } : { comments: [comment] };
            else if (url.startsWith('/api/posts/1/comments')) data = { comment };
            else if (url === '/api/posts/1') data = { post, comments: [comment] };
            else if (url.startsWith('/api/posts')) data = { posts: [post], fallback: url.includes('night') };
            else if (url === '/api/users') data = { users: [] };
            else if (url === '/api/bans') data = { bans: [] };
            return { ok: true, status: 200, json: async () => data };
        }
    });
    vm.runInContext(source, context, { filename: 'public/app.js' });
    await tick();
    const api = vm.runInContext('({ setLanguage, timeOfDay, translatedError, openEditModal, submitPostComment, saveEditPost, translations, t, renderPosts })', context);
    return { document, storage, requests, timers, clock, errors, api, context, post, window };
}

test('RU/EN translates static UI, persists after reload and preserves author content', async () => {
    const page = await interfaceFixture();
    page.document.querySelector('[data-language="en"]').click();
    assert.equal(page.document.documentElement.lang, 'en');
    assert.equal(page.document.title, 'Republic of Mari El');
    assert.equal(page.document.querySelector('h1').textContent, 'Republic of Mari El');
    assert.equal(page.document.getElementById('auth-btn').textContent, 'Log in');
    assert.equal(page.document.getElementById('post-title').getAttribute('placeholder'), 'For example: A lake in Mari El');
    for (const element of page.document.querySelectorAll('[data-i18n]')) {
        const key = element.getAttribute('data-i18n');
        if (!key) continue;
        assert.ok(page.api.translations.en[key], key);
        assert.equal(element.textContent, page.api.translations.en[key]);
    }
    assert.equal(page.document.querySelector('.post-title').textContent, 'Author title');
    assert.equal(page.document.querySelector('.comment-text').textContent, 'Original comment');
    assert.equal(page.storage.get('mari-language'), 'en');
    const reloaded = await interfaceFixture({ storage: page.storage });
    assert.equal(reloaded.document.documentElement.lang, 'en');
    reloaded.document.querySelector('[data-language="ru"]').click();
    assert.equal(reloaded.document.querySelector('h1').textContent, 'Республика Марий Эл');
    assert.deepEqual(page.errors, []);
    assert.deepEqual(reloaded.errors, []);
});

test('Language switch preserves drafts, open comments, edit mode and form language', async () => {
    const page = await interfaceFixture({ user: { id: 1, role: 'admin', username: 'admin' } });
    const { document, api } = page;
    document.getElementById('post-title').value = 'Черновик заголовка';
    document.getElementById('comment-text').value = 'Мой комментарий';
    document.getElementById('post-language').value = 'ru';
    document.querySelector('.toggle-comments-btn').click();
    await tick();
    document.getElementById('post-comment-input-1').value = 'Не отправленный текст';
    document.getElementById('post-comment-input-1-language').value = 'ru';
    api.openEditModal(page.post);
    document.getElementById('edit-night-mode').value = 'night';
    document.querySelector('[data-language="en"]').click();
    assert.equal(document.getElementById('post-title').value, 'Черновик заголовка');
    assert.equal(document.getElementById('comment-text').value, 'Мой комментарий');
    assert.equal(document.getElementById('post-language').value, 'ru');
    assert.equal(document.getElementById('post-comment-input-1').value, 'Не отправленный текст');
    assert.equal(document.getElementById('post-comment-input-1-language').value, 'ru');
    assert.ok(document.getElementById('post-comments-1').classList.contains('open'));
    assert.equal(document.getElementById('edit-night-mode').value, 'night');
    assert.equal(document.querySelector('.post-comment-text').textContent, 'Original comment');
    await api.saveEditPost({ preventDefault() {} });
    assert.equal(JSON.parse(page.requests.find(request => request.method === 'PUT').body).night_mode, 'night');
    document.querySelector('[data-admin-tab="photos"]').click();
    assert.equal(document.getElementById('admin-photos').classList.contains('hidden'), false);
    assert.equal(document.querySelector('[data-edit-photo]').textContent, 'Edit');
    assert.deepEqual(page.errors, []);
});

test('Local time boundaries, 30-minute refresh and translated fallback', async () => {
    const page = await interfaceFixture();
    for (const [hour, minute, expected] of [[5, 59, 'night'], [6, 0, 'day'], [19, 59, 'day'], [20, 0, 'night'], [0, 0, 'night']]) {
        assert.equal(page.api.timeOfDay(new Date(2026, 0, 1, hour, minute)), expected);
    }
    assert.ok(page.requests.some(request => request.url === '/api/posts?time_of_day=day'));
    assert.equal(page.timers.length, 1);
    assert.equal(page.timers[0].ms, 30 * 60 * 1000);
    page.clock.hour = 20;
    await page.timers[0].callback();
    page.api.setLanguage('en');
    assert.ok(page.requests.some(request => request.url === '/api/posts?time_of_day=night'));
    assert.match(page.document.getElementById('time-indicator').textContent, /nighttime/);
    assert.equal(page.document.getElementById('time-fallback').classList.contains('hidden'), false);
    assert.match(page.document.getElementById('time-fallback').textContent, /showing all posts/);
});

test('Blocked localStorage, translated API errors and safe user text', async () => {
    const page = await interfaceFixture({ storageBlocked: true });
    page.api.setLanguage('en');
    assert.equal(page.api.translatedError('Требуется авторизация'), 'Please log in');
    assert.match(page.api.translatedError('Ваш аккаунт заблокирован навсегда. Причина: Спам'), /permanently banned.*Спам/);
    assert.match(page.api.translatedError('Ваш аккаунт заблокирован до tomorrow. Причина: Reason'), /until tomorrow/);
    page.api.renderPosts([{ ...page.post, title: '"><img src=x onerror=alert(1)>', description: '<script>bad()</script>' }]);
    assert.equal(page.document.querySelectorAll('[onerror]').length, 0);
    assert.equal(page.document.querySelectorAll('.post-content script').length, 0);
    assert.equal(page.document.querySelector('.post-title').textContent, '"><img src=x onerror=alert(1)>');
    assert.deepEqual(page.errors, []);
});
