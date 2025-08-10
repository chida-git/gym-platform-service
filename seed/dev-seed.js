// seed/dev-seed.js
require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

(async () => {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST, port: +process.env.DB_PORT, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME
  });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Basic tables existence checks (assumes schema already created externally)
    // Insert gyms
    await conn.query(`INSERT INTO gyms (id, name, vat_number, email, phone, status, created_at)
                      VALUES (1,'Milano Fit Isola','IT12345678901','isola@milfit.it','02-000111','active',NOW()),
                             (2,'Milano Fit Navigli','IT12345678902','navigli@milfit.it','02-000222','active',NOW()),
                             (3,'Città Studi Gym','IT12345678903','cs@milfit.it','02-000333','active',NOW())
                      ON DUPLICATE KEY UPDATE name=VALUES(name)`);

    // Locations
    await conn.query(`INSERT INTO gym_locations (gym_id,address_line1,city,zone_label,latitude,longitude,is_primary,created_at)
                      VALUES
                       (1,'Via Borsieri 12','Milano','Isola',45.4891,9.1899,1,NOW()),
                       (2,'Ripa di Porta Ticinese 22','Milano','Navigli',45.4497,9.1757,1,NOW()),
                       (3,'Via Celoria 16','Milano','Città Studi',45.4771,9.2340,1,NOW())
                      `);

    // Users (app users)
    await conn.query(`INSERT INTO users (id, full_name, email, created_at)
                      VALUES (101,'Mario Rossi','mario.rossi@example.com',NOW()),
                             (102,'Giulia Bianchi','giulia.bianchi@example.com',NOW())
                      ON DUPLICATE KEY UPDATE full_name=VALUES(full_name)`);

    // Partner users (login to portal) — password: partner123!
    const hash = bcrypt.hashSync('partner123!', 10);
    await conn.query(`INSERT INTO partner_users (id, gym_id, email, full_name, role, password_hash, status, created_at)
                      VALUES (1001,1,'manager.isola@example.com','Manager Isola','admin',?, 'active', NOW()),
                             (1002,2,'manager.navigli@example.com','Manager Navigli','admin',?, 'active', NOW())
                      ON DUPLICATE KEY UPDATE email=VALUES(email), password_hash=VALUES(password_hash)`, [hash, hash]);

    // Plans (active & visible)
    await conn.query(`INSERT INTO plans (id,gym_id,name,plan_type,description,price_cents,currency,duration_days,entries_total,access_per_day,freeze_max_days,visible,active,created_at)
                      VALUES
                       (201,1,'Mensile', 'monthly','Accesso illimitato 30gg',4999,'EUR',30,NULL,1,7,1,1,NOW()),
                       (202,1,'Carnet 10', 'pack','10 ingressi',6999,'EUR',NULL,10,1,0,1,1,NOW()),
                       (203,2,'Mensile', 'monthly','Accesso illimitato 30gg',4499,'EUR',30,NULL,1,7,1,1,NOW()),
                       (204,3,'Day Pass', 'daypass','Ingresso singolo',999,'EUR',1,1,1,0,1,1,NOW())
                      ON DUPLICATE KEY UPDATE price_cents=VALUES(price_cents)`);

    // Inventory slots for today
    const today = new Date().toISOString().slice(0,10);
    await conn.query(`DELETE FROM inventory_slots WHERE date = ?`, [today]);
    await conn.query(`INSERT INTO inventory_slots (gym_id, date, time_from, time_to, capacity, available, is_active, created_at)
                      VALUES
                       (1, ?, '07:00:00','08:00:00', 20, 20, 1, NOW()),
                       (1, ?, '18:00:00','19:00:00', 25, 25, 1, NOW()),
                       (2, ?, '07:00:00','08:00:00', 15, 15, 1, NOW()),
                       (3, ?, '19:00:00','20:00:00', 30, 30, 1, NOW())`, [today,today,today,today]);

    // One subscription + booking + checkin demo
    await conn.query(`INSERT INTO subscriptions (id, user_id, gym_id, plan_id, status, start_at, end_at, auto_renew, entries_remaining, created_at)
                      VALUES (301,101,1,201,'active', NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), 0, NULL, NOW())
                      ON DUPLICATE KEY UPDATE status='active'`);
    const [insBooking] = await conn.query(`INSERT INTO bookings (user_id, gym_id, subscription_id, status, qr_token_hash, qr_expires_at, created_at)
                      VALUES (101,1,301,'checked_in', REPEAT('a',64), DATE_ADD(NOW(), INTERVAL 1 HOUR), NOW())`);
    const bookingId = insBooking.insertId;
    await conn.query(`INSERT INTO checkins (booking_id, subscription_id, verifier_device_id, source, used_at)
                      VALUES (?, 301, 'dev-device', 'qr', NOW())`, [bookingId]);

    await conn.commit();
    console.log('✅ Seed completato. Partner login: manager.isola@example.com / partner123!');
    process.exit(0);
  } catch (e) {
    await conn.rollback();
    console.error('Seed error:', e);
    process.exit(1);
  } finally {
    conn.release();
  }
})().catch(e => { console.error(e); process.exit(1); });
