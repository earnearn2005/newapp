// init_db.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    // 1. สร้างตาราง Users
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
    )`);

    // 2. เพิ่ม User เริ่มต้น (admin / 1234)
    const stmt = db.prepare("INSERT OR IGNORE INTO users (username, password) VALUES (?, ?)");
    stmt.run("admin", "1234");
    stmt.finalize();

    console.log("✅ Database initialized! User: admin, Pass: 1234");
});

db.close();