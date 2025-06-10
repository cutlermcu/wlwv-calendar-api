const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? [
        'https://wlwv-calendar.vercel.app',
        'https://wlwvlife.org',
        'https://www.wlwvlife.org',
        /\.vercel\.app$/
    ] : true,
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Database connection
let pool = null;

function initializePool(dbUrl = null) {
    const connectionString = dbUrl || process.env.DATABASE_URL;
    
    if (!connectionString) {
        console.error('No database URL provided');
        return null;
    }

    return new Pool({
        connectionString,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        max: 20,
        min: 5
    });
}

// Auto-initialize pool
if (process.env.DATABASE_URL) {
    pool = initializePool();
}

// Helper function
function formatDate(dateInput) {
    if (!dateInput) return null;
    if (dateInput instanceof Date) {
        return dateInput.toISOString().split('T')[0];
    }
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) {
        throw new Error('Invalid date format');
    }
    return date.toISOString().split('T')[0];
}

// Root route
app.get('/', (req, res) => {
    res.json({
        name: 'WLWV Life Calendar API',
        version: '2.4.0',
        status: 'running',
        environment: process.env.NODE_ENV || 'development',
        endpoints: {
            health: '/api/health',
            init: 'POST /api/init',
            dateConfigs: '/api/date-configs',
            events: '/api/events',
            materials: '/api/materials'
        }
    });
});

// Health check
app.get('/api/health', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not configured',
                connected: false
            });
        }

        const client = await pool.connect();
        const result = await client.query('SELECT NOW() as timestamp');
        client.release();

        res.json({ 
            status: 'healthy', 
            connected: true,
            timestamp: result.rows[0].timestamp
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Database connection failed',
            connected: false,
            details: error.message
        });
    }
});

// Initialize database
app.post('/api/init', async (req, res) => {
    try {
        const dbUrl = process.env.DATABASE_URL || req.body.dbUrl;

        if (!dbUrl) {
            return res.status(400).json({ 
                error: 'Database URL is required'
            });
        }

        if (pool) {
            await pool.end();
        }
        pool = initializePool(dbUrl);

        const client = await pool.connect();

        // Create tables
        await client.query(`
            CREATE TABLE IF NOT EXISTS date_configs (
                date_key DATE PRIMARY KEY,
                color VARCHAR(7),
                day_type VARCHAR(1) CHECK (day_type IN ('A', 'B')),
                is_access BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS events (
                id SERIAL PRIMARY KEY,
                school VARCHAR(10) NOT NULL CHECK (school IN ('wlhs', 'wvhs')),
                date DATE NOT NULL,
                title VARCHAR(255) NOT NULL,
                department VARCHAR(50),
                time TIME,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS materials (
                id SERIAL PRIMARY KEY,
                school VARCHAR(10) NOT NULL CHECK (school IN ('wlhs', 'wvhs')),
                date DATE NOT NULL,
                grade_level INTEGER NOT NULL CHECK (grade_level BETWEEN 9 AND 12),
                title VARCHAR(255) NOT NULL,
                link TEXT NOT NULL,
                description TEXT DEFAULT '',
                password TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        client.release();

        res.json({ 
            message: 'Database initialized successfully',
            tables: ['date_configs', 'events', 'materials']
        });

    } catch (error) {
        res.status(500).json({ 
            error: error.message
        });
    }
});

// DATE CONFIGS ROUTES
app.get('/api/date-configs', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const client = await pool.connect();
        const result = await client.query('SELECT date_key, color, day_type, is_access FROM date_configs ORDER BY date_key');
        client.release();

        const configs = result.rows.map(row => {
            return {
                date_key: formatDate(row.date_key),
                color: row.color,
                day_type: row.day_type,
                is_access: row.is_access
            };
        });

        res.json(configs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/date-configs', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { date_key, color, day_type, is_access } = req.body;

        if (!date_key) {
            return res.status(400).json({ error: 'date_key is required' });
        }

        const formattedDate = formatDate(date_key);
        const client = await pool.connect();

        await client.query(`
            INSERT INTO date_configs (date_key, color, day_type, is_access, updated_at) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (date_key) 
            DO UPDATE SET 
                color = COALESCE($2, date_configs.color),
                day_type = COALESCE($3, date_configs.day_type),
                is_access = COALESCE($4, date_configs.is_access),
                updated_at = CURRENT_TIMESTAMP
        `, [formattedDate, color || null, day_type || null, is_access || false]);

        client.release();
        res.json({ 
            success: true, 
            date_key: formattedDate, 
            color: color, 
            day_type: day_type, 
            is_access: is_access 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// EVENTS ROUTES
app.get('/api/events', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { school } = req.query;

        if (!school || !['wlhs', 'wvhs'].includes(school)) {
            return res.status(400).json({ error: 'Valid school parameter required (wlhs or wvhs)' });
        }

        const client = await pool.connect();
        const result = await client.query(
            'SELECT id, school, date, title, department, time, description FROM events WHERE school = $1 ORDER BY date, time, id',
            [school]
        );
        client.release();

        const events = result.rows.map(row => {
            return {
                id: row.id,
                school: row.school,
                date: formatDate(row.date),
                title: row.title,
                department: row.department,
                time: row.time,
                description: row.description
            };
        });

        res.json(events);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/events', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { school, date, title, department, time, description } = req.body;

        if (!school || !date || !title) {
            return res.status(400).json({ error: 'School, date, and title are required' });
        }

        if (!['wlhs', 'wvhs'].includes(school)) {
            return res.status(400).json({ error: 'School must be wlhs or wvhs' });
        }

        const formattedDate = formatDate(date);
        const client = await pool.connect();

        const result = await client.query(`
            INSERT INTO events (school, date, title, department, time, description)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, school, date, title, department, time, description
        `, [school, formattedDate, title, department || null, time || null, description || '']);

        client.release();

        const event = {
            id: result.rows[0].id,
            school: result.rows[0].school,
            date: formatDate(result.rows[0].date),
            title: result.rows[0].title,
            department: result.rows[0].department,
            time: result.rows[0].time,
            description: result.rows[0].description
        };

        res.json(event);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/events/:id', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { id } = req.params;
        const { title, department, time, description } = req.body;

        if (!title) {
            return res.status(400).json({ error: 'Title is required' });
        }

        const client = await pool.connect();

        const result = await client.query(`
            UPDATE events 
            SET title = $1, department = $2, time = $3, description = $4, updated_at = CURRENT_TIMESTAMP
            WHERE id = $5
            RETURNING id, school, date, title, department, time, description
        `, [title, department || null, time || null, description || '', id]);

        client.release();

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const event = {
            id: result.rows[0].id,
            school: result.rows[0].school,
            date: formatDate(result.rows[0].date),
            title: result.rows[0].title,
            department: result.rows[0].department,
            time: result.rows[0].time,
            description: result.rows[0].description
        };

        res.json(event);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/events/:id', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { id } = req.params;
        const client = await pool.connect();

        const result = await client.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
        client.release();

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        res.json({ success: true, id: parseInt(id) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// MATERIALS ROUTES
app.get('/api/materials', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { school } = req.query;

        if (!school || !['wlhs', 'wvhs'].includes(school)) {
            return res.status(400).json({ error: 'Valid school parameter required (wlhs or wvhs)' });
        }

        const client = await pool.connect();
        const result = await client.query(
            'SELECT id, school, date, grade_level, title, link, description, password FROM materials WHERE school = $1 ORDER BY date, grade_level, id',
            [school]
        );
        client.release();

        const materials = result.rows.map(row => {
            return {
                id: row.id,
                school: row.school,
                date: formatDate(row.date),
                grade_level: row.grade_level,
                title: row.title,
                link: row.link,
                description: row.description,
                password: row.password || ''
            };
        });

        res.json(materials);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/materials', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { school, date, grade_level, title, link, description, password } = req.body;

        if (!school || !date || !grade_level || !title || !link) {
            return res.status(400).json({ error: 'School, date, grade_level, title, and link are required' });
        }

        if (!['wlhs', 'wvhs'].includes(school)) {
            return res.status(400).json({ error: 'School must be wlhs or wvhs' });
        }

        if (![9, 10, 11, 12].includes(parseInt(grade_level))) {
            return res.status(400).json({ error: 'Grade level must be 9, 10, 11, or 12' });
        }

        const formattedDate = formatDate(date);
        const client = await pool.connect();

        const result = await client.query(`
            INSERT INTO materials (school, date, grade_level, title, link, description, password)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, school, date, grade_level, title, link, description, password
        `, [school, formattedDate, parseInt(grade_level), title, link, description || '', password || '']);

        client.release();

        const material = {
            id: result.rows[0].id,
            school: result.rows[0].school,
            date: formatDate(result.rows[0].date),
            grade_level: result.rows[0].grade_level,
            title: result.rows[0].title,
            link: result.rows[0].link,
            description: result.rows[0].description,
            password: result.rows[0].password
        };

        res.json(material);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/materials/:id', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { id } = req.params;
        const { title, link, description, password } = req.body;

        if (!title || !link) {
            return res.status(400).json({ error: 'Title and link are required' });
        }

        const client = await pool.connect();

        const result = await client.query(`
            UPDATE materials 
            SET title = $1, link = $2, description = $3, password = $4, updated_at = CURRENT_TIMESTAMP
            WHERE id = $5
            RETURNING id, school, date, grade_level, title, link, description, password
        `, [title, link, description || '', password || '', id]);

        client.release();

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Material not found' });
        }

        const material = {
            id: result.rows[0].id,
            school: result.rows[0].school,
            date: formatDate(result.rows[0].date),
            grade_level: result.rows[0].grade_level,
            title: result.rows[0].title,
            link: result.rows[0].link,
            description: result.rows[0].description,
            password: result.rows[0].password
        };

        res.json(material);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/materials/:id', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { id } = req.params;
        const client = await pool.connect();

        const result = await client.query('DELETE FROM materials WHERE id = $1 RETURNING id', [id]);
        client.release();

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Material not found' });
        }

        res.json({ success: true, id: parseInt(id) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString(),
        availableEndpoints: [
            'GET /',
            'GET /api/health',
            'POST /api/init',
            'GET /api/date-configs',
            'POST /api/date-configs',
            'GET /api/events?school={wlhs|wvhs}',
            'POST /api/events',
            'PUT /api/events/:id',
            'DELETE /api/events/:id',
            'GET /api/materials?school={wlhs|wvhs}',
            'POST /api/materials',
            'PUT /api/materials/:id',
            'DELETE /api/materials/:id'
        ]
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    if (pool) {
        await pool.end();
    }
    process.exit(0);
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 WLWV Calendar API running on port ${PORT}`);
    console.log(`📅 Date configs: /api/date-configs`);
});

module.exports = app;
