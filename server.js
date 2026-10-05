const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { rateLimit } = require('express-rate-limit');
const sharp = require('sharp');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('Задайте SESSION_SECRET длиной не менее 32 символов в .env');
}

const app = express();
const PORT = process.env.PORT || 3000;

// ── Uploads dir ──
const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(publicDir, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// ── Database ──
const db = new DatabaseSync(path.join(__dirname, 'database.sqlite'));

// Users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    display_name TEXT
  )
`);

// Bans table
db.exec(`
  CREATE TABLE IF NOT EXISTS bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    banned_by INTEGER NOT NULL,
    banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (banned_by) REFERENCES users(id)
  )
`);

// Comments table (global site comments)
db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Posts table (user posts with images)
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    image_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Post comments table
db.exec(`
  CREATE TABLE IF NOT EXISTS post_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Добавляем только новые поля: исходные тексты, авторы и даты не меняются.
db.exec('BEGIN');
try {
    const addColumn = (table, name, definition) => {
        if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
    };
    for (const table of ['posts', 'comments', 'post_comments']) {
        addColumn(table, 'language', "TEXT NOT NULL DEFAULT 'ru' CHECK(language IN ('ru', 'en'))");
    }
    addColumn('posts', 'is_night', 'INTEGER DEFAULT NULL CHECK(is_night IN (0, 1) OR is_night IS NULL)');
    // Отдельный режим сохраняет выбор «Авто» после вычисления is_night.
    addColumn('posts', 'night_mode', "TEXT NOT NULL DEFAULT 'auto' CHECK(night_mode IN ('auto', 'day', 'night'))");
    addColumn('posts', 'latitude', 'REAL DEFAULT NULL CHECK(latitude IS NULL OR (latitude >= -90 AND latitude <= 90))');
    addColumn('posts', 'longitude', 'REAL DEFAULT NULL CHECK(longitude IS NULL OR (longitude >= -180 AND longitude <= 180))');
    db.exec(`
        CREATE TABLE IF NOT EXISTS likes (
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (post_id, user_id),
            FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS favorites (
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (post_id, user_id),
            FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes(post_id);
        CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id);
    `);
    db.exec('COMMIT');
} catch (error) {
    db.exec('ROLLBACK');
    throw error;
}

// Seed default users
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
if (userCount === 0) {
    const insertUser = db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)');
    const salt = bcrypt.genSaltSync(10);

    insertUser.run('admin', bcrypt.hashSync('admin123', salt), 'admin', 'Администратор');
    insertUser.run('user1', bcrypt.hashSync('user123', salt), 'user', 'Иван Петров');
    insertUser.run('user2', bcrypt.hashSync('user456', salt), 'user', 'Мария Иванова');

    console.log('Default users seeded.');
}

// Seed demo posts with images
const postCount = db.prepare('SELECT COUNT(*) as count FROM posts').get().count;
if (postCount === 0) {
    const insertPost = db.prepare('INSERT INTO posts (user_id, title, description, image_path) VALUES (?, ?, ?, ?)');
    const adminRow = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    const adminId = adminRow ? adminRow.id : 1;

    const images = [
        { file: '1483154_original.jpg', title: 'Природа Марий Эл', desc: 'Живописные пейзажи республики.' },
        { file: '1686710855_kartin-papik-pro-p-kartinki-prirodi-respubliki-marii-el-44.jpg', title: 'Лесные просторы', desc: 'Густые хвойные леса региона.' },
        { file: '3a9071fa5a8c832476278afd45fd6ef010850ab3.jpg', title: 'Реки и озера', desc: 'Чистые водоемы Марий Эл.' },
        { file: '61acd63615e9f92fb8684ebc.jpg', title: 'Весенний пейзаж', desc: 'Красота марийской природы весной.' },
        { file: 'bolshaya-kokshaga-nature-reserve.jpg', title: 'Большая Кокшага', desc: 'Заповедник — жемчужина республики.' },
        { file: 'bruges-embankment-in-yoshkar-ola.jpg', title: 'Набережная Брюгге', desc: 'Йошкар-Ола — город уникальной архитектуры.' },
        { file: 'o9689oaoq6131i42107kap35kdzezpjx.jpg', title: 'Мари-Тауэр', desc: 'Современные здания столицы.' },
        { file: 'sea-eye.jpg', title: 'Морской глаз', desc: 'Живописное место для отдыха.' }
    ];

    images.forEach(img => {
        const imgPath = '/uploads/' + img.file;
        insertPost.run(adminId, img.title, img.desc, imgPath);
    });

    console.log('Demo posts seeded.');
}

async function analyzeNight(imagePath) {
    if (!imagePath) return null;
    const filePath = path.resolve(publicDir, '.' + imagePath);
    if (!filePath.startsWith(uploadsDir + path.sep)) return null;
    try {
        const pixels = await sharp(filePath, { failOn: 'warning', limitInputPixels: 25000000 })
            .flatten({ background: '#ffffff' }).greyscale().raw().toBuffer();
        let sum = 0;
        for (const pixel of pixels) sum += pixel;
        return pixels.length ? Number(sum / pixels.length < 80) : null;
    } catch {
        // Отсутствующее/повреждённое старое фото остаётся без классификации.
        return null;
    }
}

const ready = (async () => {
    const pending = db.prepare("SELECT id, image_path FROM posts WHERE night_mode = 'auto' AND is_night IS NULL AND image_path IS NOT NULL").all();
    for (const post of pending) {
        const night = await analyzeNight(post.image_path);
        if (night !== null) db.prepare("UPDATE posts SET is_night = ? WHERE id = ? AND night_mode = 'auto' AND is_night IS NULL").run(night, post.id);
    }
})();

// ── Middleware ──
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
});
const makeLimiter = (limit, error) => rateLimit({
    windowMs: 15 * 60 * 1000, limit,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error }
});
app.use(makeLimiter(100, 'Слишком много запросов. Повторите через 15 минут.'));
const authLimiter = makeLimiter(5, 'Превышен лимит попыток входа и регистрации. Повторите через 15 минут.');
const creationLimiter = makeLimiter(10, 'Можно отправить не более 10 постов и комментариев за 15 минут.');
const engagementLimiter = makeLimiter(60, 'Слишком много действий с лайками и избранным. Повторите через 15 минут.');
app.use(['/api/login', '/api/register'], authLimiter);
app.use('/api', (req, res, next) => { ready.then(() => next(), next); });
// Base64 увеличивает размер файла примерно на треть.
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false, limit: '8mb' }));
app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) &&
        (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
        return res.status(400).json({ error: 'Ожидается JSON-объект.' });
    }
    if (req.body?.language !== undefined && !['ru', 'en'].includes(req.body.language)) {
        return res.status(400).json({ error: 'Выберите русский или английский язык.' });
    }
    next();
});

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));

// Static files
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir, { dotfiles: 'deny' }));

// ── Helpers ──
function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    if (isBanned(req.session.userId)) {
        return req.session.destroy(() => {
            res.clearCookie('connect.sid');
            res.status(403).json({ error: 'Ваш аккаунт заблокирован. Сессия завершена.', banned: true });
        });
    }
    next();
}

function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ error: 'Требуются права администратора' });
        }
        next();
    });
}

function isBanned(userId) {
    const ban = db.prepare(`
    SELECT * FROM bans WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(userId);
    return ban || null;
}

async function saveBase64Image(base64Data, originalName) {
    const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
    if (typeof base64Data !== 'string') throw invalid('Некорректное изображение.');
    const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(base64Data);
    if (!match || match[2].length % 4 !== 0) throw invalid('Разрешены только изображения JPEG и PNG.');
    const format = match[1];
    // Старые клиенты не передают имя: для них расширение определяется декодером.
    if (originalName !== undefined && (typeof originalName !== 'string' ||
        !(format === 'jpeg' ? /\.(jpg|jpeg)$/i : /\.png$/i).test(originalName) ||
        /\.(exe|js|html|svg|php)(\.|$)/i.test(originalName))) {
        throw invalid('Расширение файла не соответствует JPEG или PNG.');
    }
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 5 * 1024 * 1024) throw invalid('Размер изображения не должен превышать 5 МБ.', 413);
    if (buffer.toString('base64') !== match[2]) throw invalid('Некорректные данные Base64.');
    let clean;
    try {
        const decoder = sharp(buffer, { failOn: 'warning', limitInputPixels: 25000000 });
        const metadata = await decoder.metadata();
        if (metadata.format !== format || (metadata.pages || 1) > 1) throw new Error('Invalid format');
        // Полное декодирование и перекодирование удаляет метаданные и посторонние хвосты файла.
        clean = await decoder.rotate().toFormat(format).toBuffer();
    } catch {
        throw invalid('Изображение повреждено, имеет неверный формат или слишком большие размеры.');
    }
    if (clean.length > 5 * 1024 * 1024) throw invalid('Обработанное изображение превышает 5 МБ.', 413);
    const filename = randomUUID() + (format === 'jpeg' ? '.jpg' : '.png');
    await fs.promises.writeFile(path.join(uploadsDir, filename), clean, { flag: 'wx' });
    return '/uploads/' + filename;
}

// ── API Routes ──

// Get current user
app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.json({ user: null });
    requireAuth(req, res, () => {
        const user = db.prepare('SELECT id, username, role, display_name FROM users WHERE id = ?').get(req.session.userId);
        res.json({ user });
    });
});

// Profile statistics for the logged-in user
app.get('/api/stats', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const scalar = (sql, ...params) => db.prepare(sql).get(...params).count;
    res.json({
        stats: {
            posts: scalar('SELECT COUNT(*) AS count FROM posts WHERE user_id = ?', userId),
            comments: scalar('SELECT COUNT(*) AS count FROM post_comments WHERE user_id = ?', userId),
            likes_received: scalar('SELECT COUNT(*) AS count FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.user_id = ?', userId),
            favorites: scalar('SELECT COUNT(*) AS count FROM favorites WHERE user_id = ?', userId)
        }
    });
});

// Register
app.post('/api/register', (req, res) => {
    const { username, password, display_name } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password ||
        Buffer.byteLength(password) > 72 ||
        (display_name != null && (typeof display_name !== 'string' || display_name.length > 100))) {
        return res.status(400).json({ error: 'Введите логин и пароль' });
    }
    if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: 'Логин должен быть от 3 до 30 символов' });
    }
    if (password.length < 4) {
        return res.status(400).json({ error: 'Пароль должен быть не менее 4 символов' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
        return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
    }

    const salt = bcrypt.genSaltSync(10);
    const password_hash = bcrypt.hashSync(password, salt);
    const name = display_name && display_name.trim() ? display_name.trim() : username;

    const result = db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
        .run(username, password_hash, 'user', name);

    req.session.userId = result.lastInsertRowid;
    res.json({
        user: {
            id: result.lastInsertRowid,
            username,
            role: 'user',
            display_name: name
        }
    });
});

// Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password ||
        username.length > 30 || Buffer.byteLength(password) > 72) {
        return res.status(400).json({ error: 'Введите логин и пароль' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const ban = isBanned(user.id);
    if (ban) {
        const msg = ban.expires_at ?
            `Ваш аккаунт заблокирован до ${ban.expires_at}. Причина: ${ban.reason}` :
            `Ваш аккаунт заблокирован навсегда. Причина: ${ban.reason}`;
        return res.status(403).json({ error: msg, banned: true });
    }

    req.session.userId = user.id;
    res.json({
        user: {
            id: user.id,
            username: user.username,
            role: user.role,
            display_name: user.display_name
        }
    });
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ── Bans (admin only) ──
app.get('/api/bans', requireAdmin, (req, res) => {
    const bans = db.prepare(`
    SELECT b.id, b.reason, b.banned_at, b.expires_at,
           u.id as user_id, u.username, u.display_name,
           a.display_name as banned_by_name
    FROM bans b
    JOIN users u ON b.user_id = u.id
    JOIN users a ON b.banned_by = a.id
    WHERE b.expires_at IS NULL OR b.expires_at > datetime('now')
    ORDER BY b.banned_at DESC
  `).all();
    res.json({ bans });
});

app.post('/api/bans', requireAdmin, (req, res) => {
    const { user_id, reason, duration_minutes } = req.body;
    if (!Number.isInteger(Number(user_id)) || Number(user_id) <= 0 ||
        typeof reason !== 'string' || !reason.trim() || reason.length > 1000 ||
        (duration_minutes != null && (!Number.isInteger(Number(duration_minutes)) || Number(duration_minutes) <= 0 || Number(duration_minutes) > 5256000))) {
        return res.status(400).json({ error: 'Укажите пользователя и причину' });
    }

    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(user_id);
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (target.role === 'admin') return res.status(403).json({ error: 'Нельзя забанить администратора' });

    let expiresAt = null;
    if (duration_minutes && duration_minutes > 0) {
        expiresAt = db.prepare("SELECT datetime('now', ? || ' minutes') as dt")
            .get(String(duration_minutes)).dt;
    }

    db.prepare('INSERT INTO bans (user_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)')
        .run(user_id, reason.trim(), req.session.userId, expiresAt);

    res.json({ success: true });
});

app.delete('/api/bans/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM bans WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// ── Global Comments ──
app.get('/api/comments', (req, res) => {
    const comments = db.prepare(`
    SELECT c.id, c.text, c.language, c.created_at, u.id as user_id, u.username, u.display_name, u.role
    FROM comments c
    JOIN users u ON c.user_id = u.id
    ORDER BY c.created_at DESC
  `).all();
    res.json({ comments });
});

app.post('/api/comments', requireAuth, creationLimiter, (req, res) => {
    const { text } = req.body;
    if (typeof text !== 'string' || !text.trim() || text.length > 5000) {
        return res.status(400).json({ error: 'Комментарий не может быть пустым' });
    }
    const result = db.prepare('INSERT INTO comments (user_id, text, language) VALUES (?, ?, ?)')
        .run(req.session.userId, text.trim(), req.body.language || 'ru');
    const comment = db.prepare(`
    SELECT c.id, c.text, c.language, c.created_at, u.id as user_id, u.username, u.display_name, u.role
    FROM comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.id = ?
  `).get(result.lastInsertRowid);
    res.json({ comment });
});

// ── Posts ──
function postSelect(whereClause = '', orderClause = 'ORDER BY p.created_at DESC') {
    return `
        SELECT p.id, p.title, p.description, p.image_path, p.created_at, p.language, p.is_night, p.night_mode, p.latitude, p.longitude,
               u.id as user_id, u.username, u.display_name, u.role,
               (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes_count,
               EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked_by_me,
               EXISTS(SELECT 1 FROM favorites f WHERE f.post_id = p.id AND f.user_id = ?) AS favorited_by_me
        FROM posts p JOIN users u ON p.user_id = u.id
        ${whereClause} ${orderClause}
    `;
}

function validCoordinates(latitude, longitude) {
    if (latitude === undefined && longitude === undefined) return { valid: true, latitude: undefined, longitude: undefined };
    if (latitude === null && longitude === null) return { valid: true, latitude: null, longitude: null };
    const lat = Number(latitude), lng = Number(longitude);
    return { valid: Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180, latitude: lat, longitude: lng };
}

app.get('/api/posts', (req, res) => {
    const timeOfDay = req.query.time_of_day;
    if (timeOfDay !== undefined && !['day', 'night'].includes(timeOfDay)) {
        return res.status(400).json({ error: 'Укажите время суток: day или night.' });
    }
    const sort = req.query.sort;
    if (sort !== undefined && !['new', 'old', 'likes'].includes(sort)) {
        return res.status(400).json({ error: 'Укажите сортировку: new, old или likes.' });
    }
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    if (search.length > 200) return res.status(400).json({ error: 'Поисковый запрос слишком длинный.' });
    const viewerId = Number(req.session.userId) || 0;
    let posts = db.prepare(postSelect()).all(viewerId, viewerId);
    if (search) {
        posts = posts.filter(post => [post.title, post.description, post.display_name, post.username]
            .some(value => typeof value === 'string' && value.toLowerCase().includes(search)));
    }
    if (sort === 'old') posts = [...posts].sort((a, b) => a.id - b.id);
    else if (sort === 'likes') posts = [...posts].sort((a, b) => b.likes_count - a.likes_count || b.id - a.id);
    const selected = timeOfDay ? posts.filter(post => post.is_night === Number(timeOfDay === 'night')) : posts;
    res.json({ posts: selected.length ? selected : posts, time_of_day: timeOfDay || null, fallback: Boolean(timeOfDay && posts.length && !selected.length) });
});

app.get('/api/posts/:id', (req, res) => {
    const viewerId = Number(req.session.userId) || 0;
    const post = db.prepare(postSelect('WHERE p.id = ?')).get(viewerId, viewerId, req.params.id);
    if (!post) return res.status(404).json({ error: 'Пост не найден' });

    const comments = db.prepare(`
    SELECT pc.id, pc.text, pc.language, pc.created_at, u.id as user_id, u.username, u.display_name, u.role
    FROM post_comments pc
    JOIN users u ON pc.user_id = u.id
    WHERE pc.post_id = ?
    ORDER BY pc.created_at DESC
  `).all(req.params.id);

    res.json({ post, comments });
});

app.post('/api/posts', requireAuth, creationLimiter, async (req, res, next) => {
    const { title, description, image_base64, image_name, latitude, longitude } = req.body;
    if (typeof title !== 'string' || !title.trim() || title.length > 200 ||
        (description != null && (typeof description !== 'string' || description.length > 10000))) {
        return res.status(400).json({ error: 'Укажите название поста' });
    }
    const coordinates = validCoordinates(latitude, longitude);
    if (!coordinates.valid) return res.status(400).json({ error: 'Введите корректные координаты: широту от -90 до 90 и долготу от -180 до 180.' });

    let imagePath = null;
    try {
        if (image_base64 != null) {
            imagePath = await saveBase64Image(image_base64, image_name);
        }
        const night = await analyzeNight(imagePath);
        // Блокировка могла появиться во время обработки изображения.
        if (isBanned(req.session.userId)) {
            if (imagePath) await fs.promises.unlink(path.join(uploadsDir, path.basename(imagePath)));
            imagePath = null;
            return requireAuth(req, res, () => {});
        }

        const result = db.prepare('INSERT INTO posts (user_id, title, description, image_path, language, is_night, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(req.session.userId, title.trim(), description ? description.trim() : null, imagePath, req.body.language || 'ru', night,
                coordinates.latitude ?? null, coordinates.longitude ?? null);

        const post = db.prepare(postSelect('WHERE p.id = ?')).get(req.session.userId, req.session.userId, result.lastInsertRowid);

        res.json({ post });
    } catch (error) {
        if (imagePath) await fs.promises.unlink(path.join(uploadsDir, path.basename(imagePath))).catch(() => {});
        next(error);
    }
});

// Edit post (admin only)
app.put('/api/posts/:id', requireAdmin, async (req, res, next) => {
    const { title, description, latitude, longitude } = req.body;
    if ((title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 200)) ||
        (description != null && (typeof description !== 'string' || description.length > 10000))) {
        return res.status(400).json({ error: 'Некорректное название или описание.' });
    }
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Пост не найден' });
    const coordinates = validCoordinates(latitude, longitude);
    if (!coordinates.valid) return res.status(400).json({ error: 'Введите корректные координаты: широту от -90 до 90 и долготу от -180 до 180.' });

    const mode = req.body.night_mode ?? (req.body.is_night === undefined ? post.night_mode :
        req.body.is_night === null ? 'auto' : [true, 1].includes(req.body.is_night) ? 'night' :
        [false, 0].includes(req.body.is_night) ? 'day' : 'invalid');
    if (!['auto', 'day', 'night'].includes(mode)) return res.status(400).json({ error: 'Выберите Авто, Дневное или Ночное.' });
    try {
    const night = mode === 'auto' ? await analyzeNight(post.image_path) : Number(mode === 'night');

    db.prepare('UPDATE posts SET title = ?, description = ?, language = ?, night_mode = ?, is_night = ?, latitude = ?, longitude = ? WHERE id = ?')
        .run(title ? title.trim() : post.title, description !== undefined ? (description ? description.trim() : null) : post.description,
            req.body.language || post.language, mode, night,
            coordinates.latitude === undefined ? post.latitude : coordinates.latitude,
            coordinates.longitude === undefined ? post.longitude : coordinates.longitude, req.params.id);

    const updated = db.prepare(postSelect('WHERE p.id = ?')).get(req.session.userId, req.session.userId, req.params.id);

    res.json({ post: updated });
    } catch (error) { next(error); }
});

// Delete post (admin only)
app.delete('/api/posts/:id', requireAdmin, (req, res) => {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Пост не найден' });

    if (post.image_path) {
        const imgPath = path.join(uploadsDir, path.basename(post.image_path));
        if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }

    db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

function requireExistingPost(postId, res) {
    const post = db.prepare('SELECT id, user_id FROM posts WHERE id = ?').get(postId);
    if (!post) { res.status(404).json({ error: 'Пост не найден' }); return null; }
    return post;
}

app.post('/api/posts/:id/like', requireAuth, engagementLimiter, (req, res) => {
    const post = requireExistingPost(req.params.id, res);
    if (!post) return;
    if (post.user_id === Number(req.session.userId)) return res.status(403).json({ error: 'Нельзя поставить лайк собственной публикации.' });
    db.prepare('INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)').run(post.id, req.session.userId);
    const likesCount = db.prepare('SELECT COUNT(*) AS count FROM likes WHERE post_id = ?').get(post.id).count;
    res.status(201).json({ liked: true, likes_count: likesCount });
});

app.delete('/api/posts/:id/like', requireAuth, engagementLimiter, (req, res) => {
    const post = requireExistingPost(req.params.id, res);
    if (!post) return;
    db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(post.id, req.session.userId);
    const likesCount = db.prepare('SELECT COUNT(*) AS count FROM likes WHERE post_id = ?').get(post.id).count;
    res.json({ liked: false, likes_count: likesCount });
});

app.post('/api/posts/:id/favorite', requireAuth, engagementLimiter, (req, res) => {
    const post = requireExistingPost(req.params.id, res);
    if (!post) return;
    db.prepare('INSERT OR IGNORE INTO favorites (post_id, user_id) VALUES (?, ?)').run(post.id, req.session.userId);
    res.status(201).json({ favorited: true });
});

app.delete('/api/posts/:id/favorite', requireAuth, engagementLimiter, (req, res) => {
    const post = requireExistingPost(req.params.id, res);
    if (!post) return;
    db.prepare('DELETE FROM favorites WHERE post_id = ? AND user_id = ?').run(post.id, req.session.userId);
    res.json({ favorited: false });
});

app.get('/api/favorites', requireAuth, (req, res) => {
    const posts = db.prepare(postSelect('WHERE EXISTS(SELECT 1 FROM favorites f WHERE f.post_id = p.id AND f.user_id = ?)', 'ORDER BY (SELECT f.created_at FROM favorites f WHERE f.post_id = p.id AND f.user_id = ?) DESC'))
        .all(req.session.userId, req.session.userId, req.session.userId, req.session.userId);
    res.json({ posts });
});

// ── Post Comments ──
app.post('/api/posts/:id/comments', requireAuth, creationLimiter, (req, res) => {
    const { text } = req.body;
    const postId = req.params.id;
    if (typeof text !== 'string' || !text.trim() || text.length > 5000) {
        return res.status(400).json({ error: 'Комментарий не может быть пустым' });
    }
    const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
    if (!post) return res.status(404).json({ error: 'Пост не найден' });

    const result = db.prepare('INSERT INTO post_comments (post_id, user_id, text, language) VALUES (?, ?, ?, ?)')
        .run(postId, req.session.userId, text.trim(), req.body.language || 'ru');

    const comment = db.prepare(`
    SELECT pc.id, pc.text, pc.language, pc.created_at, u.id as user_id, u.username, u.display_name, u.role
    FROM post_comments pc
    JOIN users u ON pc.user_id = u.id
    WHERE pc.id = ?
  `).get(result.lastInsertRowid);

    res.json({ comment });
});

// ── Users list (admin only) ──
app.get('/api/users', requireAdmin, (req, res) => {
    const users = db.prepare(`
    SELECT id, username, display_name, role FROM users WHERE role != 'admin' ORDER BY username
  `).all();
    res.json({ users });
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    const message = error.type === 'entity.too.large' ? 'Слишком большой запрос. Изображение должно быть не более 5 МБ.' :
        error.type === 'entity.parse.failed' ? 'Некорректный JSON.' :
        status < 500 ? error.message : 'Внутренняя ошибка сервера.';
    if (status >= 500) console.error('Request failed:', error.message);
    res.status(status).json({ error: message });
});

if (require.main === module) app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
module.exports = { app, db, ready };
