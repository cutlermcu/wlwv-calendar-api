const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Production-ready middleware
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? [
        'https://your-domain.com',
        'https://wlwv-calendar.vercel.app',
        /\.vercel\.app$/
    ] : true,
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Global database connection
let pool = null;

// Initialize database connection pool
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

// Auto-initialize pool if DATABASE_URL is available
if (process.env.DATABASE_URL) {
    pool = initializePool();
    console.log('Database pool initialized from environment variable');
}

// Helper function to format dates consistently
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

// Root route - API info
app.get('/', (req, res) => {
    res.json({
        name: 'WLWV Life Calendar API',
        version: '2.3.0',
        status: 'running',
        environment: process.env.NODE_ENV || 'development',
        endpoints: {
            health: '/api/health',
            init: 'POST /api/init',
            daySchedules: '/api/day-schedules',
            dayTypes: '/api/day-types',
            events: '/api/events',
            materials: '/api/materials'
        },
        features: [
            'Password-protected materials',
            'Multi-school support',
            'A/B day scheduling',
            'Event management',
            'Grade-level materials'
        ]
    });
});

// Serve the main application
app.get('/app', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not configured',
                connected: false,
                environment: process.env.NODE_ENV || 'development'
            });
        }

        const client = await pool.connect();
        const result = await client.query('SELECT NOW() as timestamp, version() as db_version');
        client.release();

        res.json({ 
            status: 'healthy', 
            message: 'Database connected',
            connected: true,
            timestamp: result.rows[0].timestamp,
            database: 'PostgreSQL',
            environment: process.env.NODE_ENV || 'development'
        });
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(500).json({ 
            error: 'Database connection failed',
            connected: false,
            details: error.message,
            environment: process.env.NODE_ENV || 'development'
        });
    }
});

// Initialize database
app.post('/api/init', async (req, res) => {
    try {
        // Use environment variable first, then fallback to request body
        const dbUrl = process.env.DATABASE_URL || req.body.dbUrl;

        if (!dbUrl) {
            return res.status(400).json({ 
                error: 'Database URL is required. Set DATABASE_URL environment variable or provide in request.',
                hasEnvVar: !!process.env.DATABASE_URL
            });
        }

        console.log('Initializing database connection...');
        
        // Create or update pool
        if (pool) {
            await pool.end();
        }
        pool = initializePool(dbUrl);

        // Test connection
        const client = await pool.connect();
        console.log('Database connection successful!');

        // Create tables with all necessary features
        console.log('Creating/updating database schema...');

        // Day schedules table
        await client.query(`
            CREATE TABLE IF NOT EXISTS day_schedules (
                date DATE PRIMARY KEY,
                schedule VARCHAR(1) NOT NULL CHECK (schedule IN ('A', 'B')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Day types table
        await client.query(`
            CREATE TABLE IF NOT EXISTS day_types (
                date DATE PRIMARY KEY,
                type VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Events table
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

        // Materials table with password support
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

        // Create performance indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_events_school_date ON events(school, date)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_materials_school_date_grade ON materials(school, date, grade_level)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_materials_date ON materials(date)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_day_schedules_date ON day_schedules(date)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_day_types_date ON day_types(date)`);

        console.log('Database schema initialized successfully!');
        client.release();

        res.json({ 
            message: 'Database initialized successfully',
            tables: ['day_schedules', 'day_types', 'events', 'materials'],
            features: ['password-protected materials', 'multi-school support', 'performance indexes'],
            environment: process.env.NODE_ENV || 'development',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Database initialization error:', error);
        
        let errorMessage = error.message;
        let suggestions = [];
        
        if (error.code === 'ENOTFOUND') {
            errorMessage = 'Database host not found. Check your connection string.';
            suggestions.push('Verify DATABASE_URL is correct');
        } else if (error.code === 'ECONNREFUSED') {
            errorMessage = 'Connection refused. Database may not be running.';
            suggestions.push('Check if Neon database is active');
        } else if (error.code === '28P01') {
            errorMessage = 'Authentication failed. Check credentials.';
            suggestions.push('Verify username and password in DATABASE_URL');
        } else if (error.code === '3D000') {
            errorMessage = 'Database does not exist.';
            suggestions.push('Check database name in connection string');
        }

        res.status(500).json({ 
            error: errorMessage,
            code: error.code,
            suggestions,
            hasEnvVar: !!process.env.DATABASE_URL
        });
    }
});

// Add password column to existing materials table
app.post('/api/add-password-column', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const client = await pool.connect();

        const columnCheck = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'materials' AND column_name = 'password'
        `);

        if (columnCheck.rows.length > 0) {
            client.release();
            return res.json({ 
                message: 'Password column already exists',
                already_exists: true
            });
        }

        await client.query(`ALTER TABLE materials ADD COLUMN password TEXT DEFAULT ''`);
        console.log('Password column added to materials table');
        client.release();

        res.json({ 
            message: 'Password column added successfully',
            added: true
        });

    } catch (error) {
        console.error('Error adding password column:', error);
        res.status(500).json({ 
            error: 'Failed to add password column',
            details: error.message
        });
    }
});

// Day Schedules Routes
app.get('/api/day-schedules', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const client = await pool.connect();
        const result = await client.query('SELECT date, schedule FROM day_schedules ORDER BY date');
        client.release();

        const schedules = result.rows.map(row => ({
            date: formatDate(row.date),
            schedule: row.schedule
        }));

        res.json(schedules);
    } catch (error) {
        console.error('Error fetching day schedules:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/day-schedules', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { date, schedule } = req.body;

        if (!date) {
            return res.status(400).json({ error: 'Date is required' });
        }

        const formattedDate = formatDate(date);
        const client = await pool.connect();

        if (!schedule || schedule === null || schedule === undefined) {
            await client.query('DELETE FROM day_schedules WHERE date = $1', [formattedDate]);
        } else {
            if (!['A', 'B'].includes(schedule)) {
                client.release();
                return res.status(400).json({ error: 'Schedule must be A or B' });
            }

            await client.query(`
                INSERT INTO day_schedules (date, schedule, updated_at) 
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (date) 
                DO UPDATE SET schedule = $2, updated_at = CURRENT_TIMESTAMP
            `, [formattedDate, schedule]);
        }

        client.release();
        res.json({ 
            success: true, 
            date: formattedDate, 
            schedule: schedule 
        });
    } catch (error) {
        console.error('Error updating day schedule:', error);
        res.status(500).json({ error: error.message });
    }
});

// Day Types Routes
app.get('/api/day-types', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const client = await pool.connect();
        const result = await client.query('SELECT date, type FROM day_types ORDER BY date');
        client.release();

        const types = result.rows.map(row => ({
            date: formatDate(row.date),
            type: row.type
        }));

        res.json(types);
    } catch (error) {
        console.error('Error fetching day types:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/day-types', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { date, type } = req.body;

        if (!date) {
            return res.status(400).json({ error: 'Date is required' });
        }

        const formattedDate = formatDate(date);
        const client = await pool.connect();

        if (!type || type === null || type === undefined) {
            await client.query('DELETE FROM day_types WHERE date = $1', [formattedDate]);
        } else {
            await client.query(`
                INSERT INTO day_types (date, type, updated_at) 
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (date) 
                DO UPDATE SET type = $2, updated_at = CURRENT_TIMESTAMP
            `, [formattedDate, type]);
        }

        client.release();
        res.json({ 
            success: true, 
            date: formattedDate, 
            type: type 
        });
    } catch (error) {
        console.error('Error updating day type:', error);
        res.status(500).json({ error: error.message });
    }
});

// Events Routes
app.get('/api/events', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { school } = req.query;

        if (!school) {
            return res.status(400).json({ error: 'School parameter is required' });
        }

        if (!['wlhs', 'wvhs'].includes(school)) {
            return res.status(400).json({ error: 'School must be wlhs or wvhs' });
        }

        const client = await pool.connect();
        const result = await client.query(
            'SELECT id, school, date, title, department, time, description, created_at, updated_at FROM events WHERE school = $1 ORDER BY date, time, id',
            [school]
        );
        client.release();

        const events = result.rows.map(row => ({
            ...row,
            date: formatDate(row.date)
        }));

        res.json(events);
    } catch (error) {
        console.error('Error fetching events:', error);
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
            RETURNING id, school, date, title, department, time, description, created_at, updated_at
        `, [school, formattedDate, title, department || null, time || null, description || '']);

        client.release();

        const event = {
            ...result.rows[0],
            date: formatDate(result.rows[0].date)
        };

        res.json(event);
    } catch (error) {
        console.error('Error creating event:', error);
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
            RETURNING id, school, date, title, department, time, description, created_at, updated_at
        `, [title, department || null, time || null, description || '', id]);

        client.release();

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const event = {
            ...result.rows[0],
            date: formatDate(result.rows[0].date)
        };

        res.json(event);
    } catch (error) {
        console.error('Error updating event:', error);
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
        console.error('Error deleting event:', error);
        res.status(500).json({ error: error.message });
    }
});

// Materials Routes with graceful password column handling
app.get('/api/materials', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const { school } = req.query;

        if (!school) {
            return res.status(400).json({ error: 'School parameter is required' });
        }

        if (!['wlhs', 'wvhs'].includes(school)) {
            return res.status(400).json({ error: 'School must be wlhs or wvhs' });
        }

        const client = await pool.connect();

        try {
            // Try with password column first
            const result = await client.query(
                'SELECT id, school, date, grade_level, title, link, description, password, created_at, updated_at FROM materials WHERE school = $1 ORDER BY date, grade_level, id',
                [school]
            );
            
            client.release();

            const materials = result.rows.map(row => ({
                ...row,
                date: formatDate(row.date),
                password: row.password || ''
            }));

            res.json(materials);
        } catch (passwordError) {
            // If password column doesn't exist, try without it
            const result = await client.query(
                'SELECT id, school, date, grade_level, title, link, description, created_at, updated_at FROM materials WHERE school = $1 ORDER BY date, grade_level, id',
                [school]
            );
            
            client.release();

            const materials = result.rows.map(row => ({
                ...row,
                date: formatDate(row.date),
                password: ''
            }));

            res.json(materials);
        }
    } catch (error) {
        console.error('Error fetching materials:', error);
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

        try {
            // Try with password column
            const result = await client.query(`
                INSERT INTO materials (school, date, grade_level, title, link, description, password)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id, school, date, grade_level, title, link, description, password, created_at, updated_at
            `, [school, formattedDate, parseInt(grade_level), title, link, description || '', password || '']);

            client.release();

            const material = {
                ...result.rows[0],
                date: formatDate(result.rows[0].date)
            };

            res.json(material);
        } catch (passwordError) {
            // If password column doesn't exist, create without it
            const result = await client.query(`
                INSERT INTO materials (school, date, grade_level, title, link, description)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id, school, date, grade_level, title, link, description, created_at, updated_at
            `, [school, formattedDate, parseInt(grade_level), title, link, description || '']);

            client.release();

            const material = {
                ...result.rows[0],
                date: formatDate(result.rows[0].date),
                password: ''
            };

            res.json(material);
        }
    } catch (error) {
        console.error('Error creating material:', error);
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

        try {
            // Try with password column
            const result = await client.query(`
                UPDATE materials 
                SET title = $1, link = $2, description = $3, password = $4, updated_at = CURRENT_TIMESTAMP
                WHERE id = $5
                RETURNING id, school, date, grade_level, title, link, description, password, created_at, updated_at
            `, [title, link, description || '', password || '', id]);

            client.release();

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Material not found' });
            }

            const material = {
                ...result.rows[0],
                date: formatDate(result.rows[0].date)
            };

            res.json(material);
        } catch (passwordError) {
            // If password column doesn't exist, update without it
            const result = await client.query(`
                UPDATE materials 
                SET title = $1, link = $2, description = $3, updated_at = CURRENT_TIMESTAMP
                WHERE id = $4
                RETURNING id, school, date, grade_level, title, link, description, created_at, updated_at
            `, [title, link, description || '', id]);

            client.release();

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Material not found' });
            }

            const material = {
                ...result.rows[0],
                date: formatDate(result.rows[0].date),
                password: ''
            };

            res.json(material);
        }
    } catch (error) {
        console.error('Error updating material:', error);
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
        console.error('Error deleting material:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin Routes
app.delete('/api/clear-all', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const client = await pool.connect();

        await client.query('DELETE FROM materials');
        await client.query('DELETE FROM events');
        await client.query('DELETE FROM day_schedules');
        await client.query('DELETE FROM day_types');

        client.release();

        res.json({ success: true, message: 'All data cleared' });
    } catch (error) {
        console.error('Error clearing data:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/fix-materials-table', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const client = await pool.connect();

        await client.query('DROP TABLE IF EXISTS materials');
        
        await client.query(`
            CREATE TABLE materials (
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

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_materials_school_date_grade ON materials(school, date, grade_level)
        `);

        client.release();

        res.json({ 
            success: true, 
            message: 'Materials table recreated with password support'
        });
    } catch (error) {
        console.error('Error fixing materials table:', error);
        res.status(500).json({ error: error.message });
    }
});

// Error handling middleware
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
        error: 'Not found',
        path: req.path,
        method: req.method
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    if (pool) {
        await pool.end();
    }
    process.exit(0);
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 WLWV Calendar API running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💾 Database: ${pool ? 'Connected' : 'Not configured'}`);
    console.log(`🌐 Health check: /api/health`);
});

module.exports = app;
