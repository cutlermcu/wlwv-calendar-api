const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS configuration for frontend compatibility
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? [
        'https://www.wlwvlife.org',
        'https://wlwv-calendar.vercel.app',
        'https://wlwv-calendar-api.vercel.app',
        /\.vercel\.app$/,
        /\.netlify\.app$/
    ] : [
        'http://localhost:3000',
        'http://localhost:8080',
        'http://localhost:5000',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:8080'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
        connectionTimeoutMillis: 15000,
        idleTimeoutMillis: 30000,
        max: 20,
        min: 2
    });
}

// Auto-initialize pool if DATABASE_URL is available
if (process.env.DATABASE_URL) {
    pool = initializePool();
    console.log('✅ Database pool initialized from environment variable');
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
        version: '3.0.0',
        status: 'running',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString(),
        endpoints: {
            health: 'GET /api/health',
            init: 'POST /api/init',
            events: {
                list: 'GET /api/events?school={wlhs|wvhs}',
                create: 'POST /api/events',
                update: 'PUT /api/events/:id',
                delete: 'DELETE /api/events/:id'
            },
            materials: {
                list: 'GET /api/materials?school={wlhs|wvhs}',
                create: 'POST /api/materials',
                update: 'PUT /api/materials/:id',
                delete: 'DELETE /api/materials/:id'
            },
            daySchedules: {
                list: 'GET /api/day-schedules',
                update: 'POST /api/day-schedules'
            },
            dayTypes: {
                list: 'GET /api/day-types',
                update: 'POST /api/day-types'
            }
        },
        features: [
            'Password-protected materials',
            'Multi-school support (WLHS/WVHS)',
            'A/B day scheduling',
            'Event management',
            'Grade-level materials (9-12)',
            'Real-time updates',
            'CORS enabled for frontend'
        ]
    });
});

// Enhanced health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                status: 'unhealthy',
                error: 'Database not configured',
                connected: false,
                environment: process.env.NODE_ENV || 'development',
                timestamp: new Date().toISOString()
            });
        }

        const client = await pool.connect();
        const result = await client.query('SELECT NOW() as timestamp, version() as db_version');
        
        // Check if required tables exist
        const tableCheck = await client.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_name IN ('events', 'materials', 'day_schedules', 'day_types')
            ORDER BY table_name
        `);
        
        client.release();

        const tables = tableCheck.rows.map(row => row.table_name);
        const allTablesExist = ['day_schedules', 'day_types', 'events', 'materials'].every(table => tables.includes(table));

        res.json({ 
            status: 'healthy', 
            message: 'Database connected and ready',
            connected: true,
            database: {
                timestamp: result.rows[0].timestamp,
                version: result.rows[0].db_version.split(' ')[0],
                tables: tables,
                tablesReady: allTablesExist
            },
            environment: process.env.NODE_ENV || 'development',
            apiVersion: '3.0.0'
        });
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(500).json({ 
            status: 'unhealthy',
            error: 'Database connection failed',
            connected: false,
            details: error.message,
            environment: process.env.NODE_ENV || 'development',
            timestamp: new Date().toISOString()
        });
    }
});

// Initialize database with enhanced error handling
app.post('/api/init', async (req, res) => {
    try {
        const dbUrl = process.env.DATABASE_URL || req.body.dbUrl;

        if (!dbUrl) {
            return res.status(400).json({ 
                error: 'Database URL is required. Set DATABASE_URL environment variable or provide in request.',
                hasEnvVar: !!process.env.DATABASE_URL,
                timestamp: new Date().toISOString()
            });
        }

        console.log('🔧 Initializing database connection...');
        
        // Create or update pool
        if (pool) {
            await pool.end();
        }
        pool = initializePool(dbUrl);

        // Test connection
        const client = await pool.connect();
        console.log('✅ Database connection successful!');

        // Create enhanced tables
        console.log('📝 Creating/updating database schema...');

        // Events table
        await client.query(`
            CREATE TABLE IF NOT EXISTS events (
                id SERIAL PRIMARY KEY,
                school VARCHAR(10) NOT NULL CHECK (school IN ('wlhs', 'wvhs')),
                date DATE NOT NULL,
                title VARCHAR(255) NOT NULL,
                department VARCHAR(100),
                time TIME,
                description TEXT DEFAULT '',
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
                type VARCHAR(100) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create optimized indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_events_school_date ON events(school, date)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_materials_school_date_grade ON materials(school, date, grade_level)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_materials_school_grade ON materials(school, grade_level)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_materials_date ON materials(date)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_day_schedules_date ON day_schedules(date)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_day_types_date ON day_types(date)`);

        console.log('✅ Database schema initialized successfully!');
        client.release();

        res.json({ 
            success: true,
            message: 'Database initialized successfully',
            tables: ['events', 'materials', 'day_schedules', 'day_types'],
            indexes: [
                'idx_events_school_date',
                'idx_events_date',
                'idx_materials_school_date_grade',
                'idx_materials_school_grade',
                'idx_materials_date',
                'idx_day_schedules_date',
                'idx_day_types_date'
            ],
            features: [
                'Multi-school support',
                'Password-protected materials',
                'Grade-level filtering',
                'Optimized indexes',
                'Date validation'
            ],
            environment: process.env.NODE_ENV || 'development',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Database initialization error:', error);
        
        let errorMessage = error.message;
        let suggestions = [];
        
        if (error.code === 'ENOTFOUND') {
            errorMessage = 'Database host not found. Check your connection string.';
            suggestions.push('Verify DATABASE_URL is correct');
        } else if (error.code === 'ECONNREFUSED') {
            errorMessage = 'Connection refused. Database may not be running.';
            suggestions.push('Check if database is active');
        } else if (error.code === '28P01') {
            errorMessage = 'Authentication failed. Check credentials.';
            suggestions.push('Verify username and password in DATABASE_URL');
        } else if (error.code === '3D000') {
            errorMessage = 'Database does not exist.';
            suggestions.push('Check database name in connection string');
        }

        res.status(500).json({ 
            success: false,
            error: errorMessage,
            code: error.code,
            suggestions,
            hasEnvVar: !!process.env.DATABASE_URL,
            timestamp: new Date().toISOString()
        });
    }
});

// Events Routes
app.get('/api/events', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const { school } = req.query;

        if (!school) {
            return res.status(400).json({ 
                error: 'School parameter is required (wlhs or wvhs)',
                timestamp: new Date().toISOString()
            });
        }

        if (!['wlhs', 'wvhs'].includes(school)) {
            return res.status(400).json({ 
                error: 'School must be wlhs or wvhs',
                timestamp: new Date().toISOString()
            });
        }

        const client = await pool.connect();
        const result = await client.query(
            `SELECT id, school, date, title, department, time, description, created_at, updated_at 
             FROM events 
             WHERE school = $1 
             ORDER BY date ASC, time ASC, id ASC`,
            [school]
        );
        client.release();

        const events = result.rows.map(row => ({
            ...row,
            date: formatDate(row.date)
        }));

        res.json({
            data: events,
            count: events.length,
            school: school,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error fetching events:', error);
        res.status(500).json({ 
            error: 'Failed to fetch events',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/events', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const { school, date, title, department, time, description } = req.body;

        // Validation
        if (!school || !date || !title) {
            return res.status(400).json({ 
                error: 'School, date, and title are required',
                required: ['school', 'date', 'title'],
                timestamp: new Date().toISOString()
            });
        }

        if (!['wlhs', 'wvhs'].includes(school)) {
            return res.status(400).json({ 
                error: 'School must be wlhs or wvhs',
                timestamp: new Date().toISOString()
            });
        }

        const formattedDate = formatDate(date);
        const client = await pool.connect();

        const result = await client.query(`
            INSERT INTO events (school, date, title, department, time, description, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            RETURNING id, school, date, title, department, time, description, created_at, updated_at
        `, [school, formattedDate, title, department || null, time || null, description || '']);

        client.release();

        const event = {
            ...result.rows[0],
            date: formatDate(result.rows[0].date)
        };

        res.status(201).json({
            success: true,
            data: event,
            message: 'Event created successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error creating event:', error);
        res.status(500).json({ 
            error: 'Failed to create event',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.put('/api/events/:id', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const { id } = req.params;
        const { title, department, time, description } = req.body;

        if (!title) {
            return res.status(400).json({ 
                error: 'Title is required',
                timestamp: new Date().toISOString()
            });
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
            return res.status(404).json({ 
                error: 'Event not found',
                timestamp: new Date().toISOString()
            });
        }

        const event = {
            ...result.rows[0],
            date: formatDate(result.rows[0].date)
        };

        res.json({
            success: true,
            data: event,
            message: 'Event updated successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error updating event:', error);
        res.status(500).json({ 
            error: 'Failed to update event',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.delete('/api/events/:id', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const { id } = req.params;
        const client = await pool.connect();

        const result = await client.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
        client.release();

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                error: 'Event not found',
                timestamp: new Date().toISOString()
            });
        }

        res.json({ 
            success: true, 
            message: 'Event deleted successfully',
            id: parseInt(id),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error deleting event:', error);
        res.status(500).json({ 
            error: 'Failed to delete event',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Materials Routes
app.get('/api/materials', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const { school, grade } = req.query;

        if (!school) {
            return res.status(400).json({ 
                error: 'School parameter is required (wlhs or wvhs)',
                timestamp: new Date().toISOString()
            });
        }

        if (!['wlhs', 'wvhs'].includes(school)) {
            return res.status(400).json({ 
                error: 'School must be wlhs or wvhs',
                timestamp: new Date().toISOString()
            });
        }

        const client = await pool.connect();

        let query = `
            SELECT id, school, date, grade_level, title, link, description, password, created_at, updated_at 
            FROM materials 
            WHERE school = $1
        `;
        let params = [school];

        if (grade) {
            const gradeNum = parseInt(grade);
            if (![9, 10, 11, 12].includes(gradeNum)) {
                client.release();
                return res.status(400).json({ 
                    error: 'Grade must be 9, 10, 11, or 12',
                    timestamp: new Date().toISOString()
                });
            }
            query += ` AND grade_level = $2`;
            params.push(gradeNum);
        }

        query += ` ORDER BY date ASC, grade_level ASC, id ASC`;

        const result = await client.query(query, params);
        client.release();

        const materials = result.rows.map(row => ({
            ...row,
            date: formatDate(row.date),
            password: row.password || ''
        }));

        res.json({
            data: materials,
            count: materials.length,
            school: school,
            grade: grade || 'all',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error fetching materials:', error);
        res.status(500).json({ 
            error: 'Failed to fetch materials',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/materials', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const { school, date, grade_level, title, link, description, password } = req.body;

        // Validation
        if (!school || !date || !grade_level || !title || !link) {
            return res.status(400).json({ 
                error: 'School, date, grade_level, title, and link are required',
                required: ['school', 'date', 'grade_level', 'title', 'link'],
                timestamp: new Date().toISOString()
            });
        }

        if (!['wlhs', 'wvhs'].includes(school)) {
            return res.status(400).json({ 
                error: 'School must be wlhs or wvhs',
                timestamp: new Date().toISOString()
            });
        }

        const gradeNum = parseInt(grade_level);
        if (![9, 10, 11, 12].includes(gradeNum)) {
            return res.status(400).json({ 
                error: 'Grade level must be 9, 10, 11, or 12',
                timestamp: new Date().toISOString()
            });
        }

        const formattedDate = formatDate(date);
        const client = await pool.connect();

        const result = await client.query(`
            INSERT INTO materials (school, date, grade_level, title, link, description, password, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
            RETURNING id, school, date, grade_level, title, link, description, password, created_at, updated_at
        `, [school, formattedDate, gradeNum, title, link, description || '', password || '']);

        client.release();

        const material = {
            ...result.rows[0],
            date: formatDate(result.rows[0].date)
        };

        res.status(201).json({
            success: true,
            data: material,
            message: 'Material created successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error creating material:', error);
        res.status(500).json({ 
            error: 'Failed to create material',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.put('/api/materials/:id', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const { id } = req.params;
        const { title, link, description, password } = req.body;

        if (!title || !link) {
            return res.status(400).json({ 
                error: 'Title and link are required',
                timestamp: new Date().toISOString()
            });
        }

        const client = await pool.connect();

        const result = await client.query(`
            UPDATE materials 
            SET title = $1, link = $2, description = $3, password = $4, updated_at = CURRENT_TIMESTAMP
            WHERE id = $5
            RETURNING id, school, date, grade_level, title, link, description, password, created_at, updated_at
        `, [title, link, description || '', password || '', id]);

        client.release();

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                error: 'Material not found',
                timestamp: new Date().toISOString()
            });
        }

        const material = {
            ...result.rows[0],
            date: formatDate(result.rows[0].date)
        };

        res.json({
            success: true,
            data: material,
            message: 'Material updated successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error updating material:', error);
        res.status(500).json({ 
            error: 'Failed to update material',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.delete('/api/materials/:id', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const { id } = req.params;
        const client = await pool.connect();

        const result = await client.query('DELETE FROM materials WHERE id = $1 RETURNING id', [id]);
        client.release();

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                error: 'Material not found',
                timestamp: new Date().toISOString()
            });
        }

        res.json({ 
            success: true, 
            message: 'Material deleted successfully',
            id: parseInt(id),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error deleting material:', error);
        res.status(500).json({ 
            error: 'Failed to delete material',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Day Schedules Routes
app.get('/api/day-schedules', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const client = await pool.connect();
        const result = await client.query('SELECT date, schedule FROM day_schedules ORDER BY date ASC');
        client.release();

        const schedules = result.rows.map(row => ({
            date: formatDate(row.date),
            schedule: row.schedule
        }));

        res.json({
            data: schedules,
            count: schedules.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error fetching day schedules:', error);
        res.status(500).json({ 
            error: 'Failed to fetch day schedules',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/day-schedules', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const { date, schedule } = req.body;

        if (!date) {
            return res.status(400).json({ 
                error: 'Date is required',
                timestamp: new Date().toISOString()
            });
        }

        const formattedDate = formatDate(date);
        const client = await pool.connect();

        if (!schedule || schedule === null || schedule === undefined) {
            // Delete schedule
            await client.query('DELETE FROM day_schedules WHERE date = $1', [formattedDate]);
            client.release();
            
            res.json({ 
                success: true, 
                message: 'Day schedule removed',
                date: formattedDate, 
                schedule: null,
                timestamp: new Date().toISOString()
            });
        } else {
            // Validate schedule
            if (!['A', 'B'].includes(schedule)) {
                client.release();
                return res.status(400).json({ 
                    error: 'Schedule must be A or B',
                    timestamp: new Date().toISOString()
                });
            }

            await client.query(`
                INSERT INTO day_schedules (date, schedule, updated_at) 
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (date) 
                DO UPDATE SET schedule = $2, updated_at = CURRENT_TIMESTAMP
            `, [formattedDate, schedule]);
            
            client.release();

            res.json({ 
                success: true, 
                message: 'Day schedule updated',
                date: formattedDate, 
                schedule: schedule,
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        console.error('Error updating day schedule:', error);
        res.status(500).json({ 
            error: 'Failed to update day schedule',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Day Types Routes
app.get('/api/day-types', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const client = await pool.connect();
        const result = await client.query('SELECT date, type FROM day_types ORDER BY date ASC');
        client.release();

        const types = result.rows.map(row => ({
            date: formatDate(row.date),
            type: row.type
        }));

        res.json({
            data: types,
            count: types.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error fetching day types:', error);
        res.status(500).json({ 
            error: 'Failed to fetch day types',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/day-types', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const { date, type } = req.body;

        if (!date) {
            return res.status(400).json({ 
                error: 'Date is required',
                timestamp: new Date().toISOString()
            });
        }

        const formattedDate = formatDate(date);
        const client = await pool.connect();

        if (!type || type === null || type === undefined) {
            // Delete type
            await client.query('DELETE FROM day_types WHERE date = $1', [formattedDate]);
            client.release();
            
            res.json({ 
                success: true, 
                message: 'Day type removed',
                date: formattedDate, 
                type: null,
                timestamp: new Date().toISOString()
            });
        } else {
            await client.query(`
                INSERT INTO day_types (date, type, updated_at) 
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (date) 
                DO UPDATE SET type = $2, updated_at = CURRENT_TIMESTAMP
            `, [formattedDate, type]);
            
            client.release();

            res.json({ 
                success: true, 
                message: 'Day type updated',
                date: formattedDate, 
                type: type,
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        console.error('Error updating day type:', error);
        res.status(500).json({ 
            error: 'Failed to update day type',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Admin Routes
app.delete('/api/admin/clear-all', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ 
                error: 'Database not connected',
                timestamp: new Date().toISOString()
            });
        }

        const client = await pool.connect();

        // Get counts before clearing
        const eventCount = await client.query('SELECT COUNT(*) FROM events');
        const materialCount = await client.query('SELECT COUNT(*) FROM materials');
        const scheduleCount = await client.query('SELECT COUNT(*) FROM day_schedules');
        const typeCount = await client.query('SELECT COUNT(*) FROM day_types');

        // Clear all data
        await client.query('DELETE FROM materials');
        await client.query('DELETE FROM events');
        await client.query('DELETE FROM day_schedules');
        await client.query('DELETE FROM day_types');

        client.release();

        res.json({ 
            success: true, 
            message: 'All data cleared successfully',
            cleared: {
                events: parseInt(eventCount.rows[0].count),
                materials: parseInt(materialCount.rows[0].count),
                daySchedules: parseInt(scheduleCount.rows[0].count),
                dayTypes: parseInt(typeCount.rows[0].count)
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error clearing data:', error);
        res.status(500).json({ 
            error: 'Failed to clear data',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
        timestamp: new Date().toISOString()
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
            'GET /api/events?school={wlhs|wvhs}',
            'POST /api/events',
            'PUT /api/events/:id',
            'DELETE /api/events/:id',
            'GET /api/materials?school={wlhs|wvhs}',
            'POST /api/materials',
            'PUT /api/materials/:id',
            'DELETE /api/materials/:id',
            'GET /api/day-schedules',
            'POST /api/day-schedules',
            'GET /api/day-types',
            'POST /api/day-types',
            'DELETE /api/admin/clear-all'
        ]
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🔄 SIGTERM received, shutting down gracefully');
    if (pool) {
        await pool.end();
        console.log('📦 Database pool closed');
    }
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🔄 SIGINT received, shutting down gracefully');
    if (pool) {
        await pool.end();
        console.log('📦 Database pool closed');
    }
    process.exit(0);
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 WLWV Calendar API v3.0.0 running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💾 Database: ${pool ? '✅ Connected' : '❌ Not configured'}`);
    console.log(`🌐 Health check: ${process.env.NODE_ENV === 'production' ? 'https://wlwv-calendar-api.vercel.app' : `http://localhost:${PORT}`}/api/health`);
    console.log(`📚 API docs: ${process.env.NODE_ENV === 'production' ? 'https://wlwv-calendar-api.vercel.app' : `http://localhost:${PORT}`}/`);
});

module.exports = app;
