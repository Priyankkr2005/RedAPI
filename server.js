// server.js (Full RedApe - Ready for Render Deployment)
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const cron = require('node-cron');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(bodyParser.json());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

const monitorSchema = new mongoose.Schema({
  url: String,
  name: String,
  email: String,
  phone: String,
  countryCode: String,
  interval: String,
  method: { type: String, default: 'GET' },
  expectedStatus: { type: Number, default: 200 }
});
const Monitor = mongoose.model('Monitor', monitorSchema);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

const activeTasks = {};
const downtimeTracker = {};

function getCronExpression(interval) {
  switch (interval) {
    case '10sec': return '*/10 * * * * *';
    case '30sec': return '*/30 * * * * *';
    case '1min': return '*/1 * * * *';
    case '5min': return '*/5 * * * *';
    default: return null;
  }
}

app.post('/register', async (req, res) => {
  const { url, name, email, phone, countryCode, interval, method = 'GET', expectedStatus = 200 } = req.body;
  const cronExpr = getCronExpression(interval);
  if (!cronExpr) return res.status(400).send('Invalid interval.');

  const newMonitor = new Monitor({ url, name, email, phone, countryCode, interval, method, expectedStatus });
  await newMonitor.save();
  const monitorId = newMonitor._id;
  downtimeTracker[monitorId] = false;

  activeTasks[monitorId] = cron.schedule(cronExpr, async () => {
    const now = new Date();

    try {
      const response = await axios({ url, method, timeout: 5000 });
      if (response.status === expectedStatus) {
        console.log(`[API OK ✅] ${method} ${url} at ${now.toISOString()}`);
        downtimeTracker[monitorId] = false;
      } else {
        throw new Error(`Expected ${expectedStatus}, got ${response.status}`);
      }
    } catch (err) {
      console.log(`[API DOWN ❌] ${method} ${url} - ${err.message}`);

      // Send alert on every failure cycle
      transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: `🚨 API Still Down: ${method} ${url}`,
        text: `${method} ${url} is still down at ${now.toLocaleTimeString()} – ${err.message}`
      }).catch(console.error);

      if (phone && countryCode) {
        twilioClient.messages.create({
          body: `🚨 API STILL DOWN: ${method} ${url} - ${err.message}`,
          from: process.env.TWILIO_PHONE,
          to: `${countryCode}${phone}`
        }).catch(console.error);
      }

      downtimeTracker[monitorId] = true;
    }
  });

  res.send('✅ RedApe API Monitoring started!');
});

app.post('/stop-monitoring', async (req, res) => {
  for (const id in activeTasks) {
    activeTasks[id].stop();
  }
  res.send('Monitoring stopped.');
});

app.get('/api/monitors', async (req, res) => {
  const monitors = await Monitor.find({});
  res.json(monitors);
});

app.listen(PORT, () => console.log(`🚀 RedApe running at http://localhost:${PORT}`));
