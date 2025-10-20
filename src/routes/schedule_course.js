// src/routes/schedule.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

//router.use(requireAuth);

/**
 * GET /gyms/:gymId/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD&courseTypeId=?
 * genera occorrenze on-the-fly e applica eventuali override
 */
router.get('/:gymId/schedule', async (req, res, next) => {
  try {
    const { gymId } = req.params;
    const { from, to, courseTypeId } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'from and to are required' });

    // MySQL 8 recursive CTE
    const [rows] = await pool.query(
`WITH RECURSIVE dates AS (
  SELECT DATE(?) AS d
  UNION ALL
  SELECT DATE_ADD(d, INTERVAL 1 DAY) FROM dates WHERE DATE_ADD(d, INTERVAL 1 DAY) < DATE(?)
),
generated AS (
  SELECT
    ws.id              AS weekly_slot_id,
    ws.gym_id,
    ws.course_type_id,
    d.d                AS day_date,
    ws.weekday,
    ws.start_time,
    ws.duration_min,
    ws.capacity,
    ct.name            AS course_name
  FROM weekly_slots ws
  JOIN course_types ct ON ct.id = ws.course_type_id AND ct.status='active'
  JOIN dates d ON ws.is_active=1 AND WEEKDAY(d.d) = ws.weekday
  WHERE ws.gym_id = ?
    ${courseTypeId ? 'AND ws.course_type_id = ?' : ''}
)
SELECT
  g.weekly_slot_id   AS weeklySlotId,
  g.gym_id           AS gymId,
  g.course_type_id   AS courseTypeId,
  g.course_name      AS courseName,
  TIMESTAMP(g.day_date, COALESCE(co.start_time, g.start_time)) AS startsAt,
  TIMESTAMP(g.day_date, COALESCE(co.start_time, g.start_time))
     + INTERVAL COALESCE(co.duration_min, g.duration_min) MINUTE AS endsAt,
  COALESCE(g.capacity, NULL) AS capacity,
  CASE WHEN co.cancelled = 1 THEN 'cancelled' ELSE 'scheduled' END AS status,
  COALESCE(co.notes, NULL) AS notes
FROM generated g
LEFT JOIN class_overrides co
  ON co.weekly_slot_id = g.weekly_slot_id
 AND co.override_date = g.day_date
ORDER BY startsAt`, courseTypeId ? [from, to, gymId, courseTypeId] : [from, to, gymId]
    );

    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
