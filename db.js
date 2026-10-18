const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

const pool = mysql.createPool({
  // DB_* wins (local .env); the MYSQL* names are what Railway's MySQL
  // service provides, so a Railway deploy works without renaming anything.
  host: process.env.DB_HOST || process.env.MYSQLHOST,
  port: process.env.DB_PORT || process.env.MYSQLPORT || 3306,
  user: process.env.DB_USER || process.env.MYSQLUSER,
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
  database: process.env.DB_NAME || process.env.MYSQLDATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: false,
  decimalNumbers: true, // return DECIMAL columns as JS numbers, not strings
  charset: 'utf8mb4',   // without this, special characters like ≥ get mangled
});

module.exports = pool;
