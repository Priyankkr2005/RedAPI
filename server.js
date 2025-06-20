app.post('/register', async (req, res) => {
  const { url, name, email, phone, countryCode, interval } = req.body;
  const cronExpr = getCronExpression(interval);
  if (!cronExpr) return res.status(400).send('Invalid interval.');

  // Create and save monitor
  const newMonitor = new Monitor({
    url,
    name,
    email,
    phone,
    countryCode,
    interval,
    logs: []
  });
  await newMonitor.save();
  const monitorId = newMonitor._id;
  downtimeTracker[monitorId] = null;

  // Cron logic
  activeTasks[monitorId] = cron.schedule(cronExpr, async () => {
    const now = new Date();

    try {
      await axios.get(url, { timeout: 5000 });
      console.log(`[UP] ${url} at ${now.toISOString()}`);

      // Save downtime log if it just came back up
      if (downtimeTracker[monitorId]?.start) {
        const { start, notified } = downtimeTracker[monitorId];
        const end = now;
        const duration = Math.round((end - start) / 60000);

        const freshMonitor = await Monitor.findById(monitorId);
        if (freshMonitor) {
          freshMonitor.logs.push({ start, end, durationMinutes: duration });
          await freshMonitor.save();
          console.log(`✅ Downtime logged to DB for ${url}`);
        }

        downtimeTracker[monitorId] = null;
      }

    } catch (err) {
      console.log(`[DOWN] ${url} at ${now.toISOString()}`);

      if (!downtimeTracker[monitorId]) {
        downtimeTracker[monitorId] = { start: now, notified: false };
      }

      const tracked = downtimeTracker[monitorId];
      const durationMs = now - tracked.start;

      if (!tracked.notified && durationMs <= 5 * 60 * 1000) {
        downtimeTracker[monitorId].notified = true;

        transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: email,
          subject: `🚨 ${url} is DOWN`,
          text: `${url} is down as of ${now.toLocaleTimeString()}`
        }).catch(console.error);

        if (phone && countryCode) {
          twilioClient.messages.create({
            body: `${url} is DOWN!`,
            from: process.env.TWILIO_PHONE,
            to: `${countryCode}${phone}`
          }).catch(console.error);
        }
      }
    }
  });

  res.send('Monitoring started successfully!');
});
