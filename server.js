const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');

const app = express();
dotenv.config();

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// DB Setup
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Model
const monitorSchema = new mongoose.Schema({
  url: String,
  name: String,
  email: String,
  phone: String,
  countryCode: String,
  interval: String,
  method: String,
  expectedStatus: Number,
  logs: [
    {
      start: Date,
      end: Date,
      durationMinutes: Number,
    },
  ],
});

const Monitor = mongoose.model('Monitor', monitorSchema);

const getCronExpression = (interval) => {
  switch (interval) {
    case '10sec': return '*/10 * * * * *';
    case '30sec': return '*/30 * * * * *';
    case '1min': return '*/1 * * * *';
    case '5min': return '*/5 * * * *';
    default: return null;
  }
};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
const activeTasks = {};
const downtimeTracker = {};

// Serve logs.html
app.get('/logs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

// Fetch all monitors (logs + delete)
app.get('/api/monitors', async (req, res) => {
  const monitors = await Monitor.find({}, '-__v');
  res.json(monitors);
});

// Delete monitor
app.delete('/api/monitor/:id', async (req, res) => {
  const id = req.params.id;
  await Monitor.findByIdAndDelete(id);

  if (activeTasks[id]) {
    activeTasks[id].stop();
    delete activeTasks[id];
  }

  delete downtimeTracker[id];
  res.send('Deleted');
});

// Register monitor
app.post('/register', async (req, res) => {
  const { url, name, email, phone, countryCode, interval, method, expectedStatus } = req.body;
  const cronExpr = getCronExpression(interval);
  if (!cronExpr) return res.status(400).send('Invalid interval.');

  const newMonitor = new Monitor({
    url,
    name,
    email,
    phone,
    countryCode,
    interval,
    method: method || 'GET',
    expectedStatus: expectedStatus || 200,
    logs: []
  });

  await newMonitor.save();
  const monitorId = newMonitor._id;
  downtimeTracker[monitorId] = null;

  activeTasks[monitorId] = cron.schedule(cronExpr, async () => {
    const now = new Date();
    try {
      const response = await axios({ method: method || 'GET', url, timeout: 5000 });
      const statusMatches = response.status === expectedStatus;
      if (statusMatches) {
        console.log(`[UP] ${url} at ${now.toISOString()}`);

        if (downtimeTracker[monitorId]?.start) {
          const { start } = downtimeTracker[monitorId];
          const end = now;
          const duration = Math.round((end - start) / 60000);

          const freshMonitor = await Monitor.findById(monitorId);
          if (freshMonitor) {
            freshMonitor.logs.push({ start, end, durationMinutes: duration });
            await freshMonitor.save();
          }

          downtimeTracker[monitorId] = null;
        }
      } else {
        throw new Error(`Expected ${expectedStatus}, got ${response.status}`);
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

// Stop all monitoring (for testing)
app.post('/stop-monitoring', (req, res) => {
  for (let id in activeTasks) {
    activeTasks[id].stop();
  }
  res.send('All monitoring stopped');
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
