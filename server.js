const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

const app = express();
const db = new sqlite3.Database('./database.sqlite');
const DATA_DIR = './data';

app.use('/img', express.static('img'));

// Config
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'mysecretkey',
    resave: false,
    saveUninitialized: true
}));

// Helper: Read CSV
const readCSV = (fileName) => {
    return new Promise((resolve) => {
        const results = [];
        const filePath = path.join(DATA_DIR, `${fileName}.csv`);
        if (!fs.existsSync(filePath)) return resolve([]);
        
        fs.createReadStream(filePath)
            .pipe(csv({
                mapHeaders: ({ header }) => header.trim().replace(/^\uFEFF/, '')
            }))
            .on('data', (data) => {
                const cleanData = {};
                Object.keys(data).forEach(key => cleanData[key] = data[key].trim());
                results.push(cleanData);
            })
            .on('end', () => resolve(results));
    });
};

// Middleware
const requireLogin = (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    next();
};

// Routes
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (row) {
            req.session.user = row;
            res.redirect('/timetable');
        } else {
            res.render('login', { error: "Invalid Credentials" });
        }
    });
});

app.get('/timetable', requireLogin, async (req, res) => {
    // 1. อ่านข้อมูล Master Data สำหรับ Dropdown
    const teachers = await readCSV('teacher');
    const rooms = await readCSV('room');
    const groups = await readCSV('student_group');
    const subjects = await readCSV('subject');

    // 2. อ่านข้อมูลตารางสอน (Output)
    const schedule = [];
    if (fs.existsSync('output.csv')) {
        fs.createReadStream('output.csv')
            .pipe(csv())
            .on('data', (data) => schedule.push(data))
            .on('end', () => {
                res.render('timetable', { 
                    user: req.session.user, 
                    schedule, teachers, rooms, groups, subjects
                });
            });
    } else {
        res.render('timetable', { 
            user: req.session.user, 
            schedule: [], teachers, rooms, groups, subjects,
            error: "Please run scheduler (index.js) first." 
        });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/', (req, res) => res.redirect('/timetable'));

app.listen(3000, () => console.log("🌐 Server running on http://localhost:3000"));