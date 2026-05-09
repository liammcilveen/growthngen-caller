'use strict';

/**
 * Cal.com booking service.
 * Used by the book_meeting server tool (Phase 2).
 *
 * Uses the Cal.com v1 API:
 *   GET /v1/slots/available   — find available slots
 *   POST /v1/bookings         — create a booking
 */

const axios = require('axios');
const logger = require('../logger');
const { config } = require('../config');

function headers() {
  return {
    Authorization: `Bearer ${config.calcom.apiKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Get available slots for the GrowthNGen Discovery Call event type.
 * Returns an array of slot objects: [{ time: ISO, date: YYYY-MM-DD }, ...]
 */
async function getAvailableSlots(daysAhead = 7) {
  const startTime = new Date().toISOString();
  const endTime = new Date(Date.now() + daysAhead * 86400000).toISOString();

  try {
    const resp = await axios.get(`${config.calcom.baseUrl}/slots/available`, {
      headers: headers(),
      params: {
        eventTypeId: config.calcom.eventTypeId,
        startTime,
        endTime,
        timeZone: 'Australia/Sydney',
      },
      timeout: 8000,
    });

    // Cal.com v1 returns { slots: { "YYYY-MM-DD": [{ time: ISO }] } }
    const slotsByDate = resp.data.slots || {};
    const slots = [];
    for (const [date, times] of Object.entries(slotsByDate)) {
      for (const slot of times) {
        slots.push({ date, time: slot.time });
      }
    }
    logger.info({ count: slots.length }, 'Cal.com slots fetched');
    return slots;
  } catch (err) {
    logger.error({ err: err.message }, 'Cal.com getAvailableSlots failed');
    return [];
  }
}

/**
 * Create a Cal.com booking.
 *
 * @param {string} startTime — exact ISO timestamp from getAvailableSlots
 * @param {{ name: string, email: string }} attendee
 * @returns booking details or null on failure
 */
async function createBooking(startTime, attendee) {
  try {
    const resp = await axios.post(
      `${config.calcom.baseUrl}/bookings`,
      {
        eventTypeId: config.calcom.eventTypeId,
        start: startTime,
        attendee: {
          name: attendee.name,
          email: attendee.email,
          timeZone: attendee.timeZone || 'Australia/Sydney',
        },
        metadata: { source: 'growthngen-sdr-will' },
      },
      { headers: headers(), timeout: 10000 }
    );

    const booking = resp.data;
    logger.info({ bookingUid: booking.uid, attendeeEmail: attendee.email, startTime }, 'Cal.com booking created');
    return {
      uid: booking.uid,
      title: booking.title,
      startTime: booking.startTime,
      endTime: booking.endTime,
      meetLink: booking.metadata?.videoCallUrl || booking.videoCallUrl || null,
    };
  } catch (err) {
    logger.error({ err: err.message, attendee, startTime }, 'Cal.com createBooking failed');
    return null;
  }
}

/**
 * Format a slot for human-readable presentation by Will.
 * "Thursday 15 May at 10:00 AM"
 */
function formatSlotForSpeech(isoTime) {
  const d = new Date(isoTime);
  return d.toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Australia/Sydney',
  });
}

module.exports = { getAvailableSlots, createBooking, formatSlotForSpeech };
