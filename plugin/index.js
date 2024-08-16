const fs = require("fs");
const fetch = require("node-fetch");
const path = require("path");

let pluginSettings = {};
const offlineDataFilePath = path.join(__dirname, "offlineData.json"); // Path to store offline data
let isConnected = true;

const KEYS = {
  position: "navigation.position",
  speed: "navigation.speedOverGround",
  heading: "navigation.headingTrue",
  log: "navigation.trip.log",
  depth: "environment.depth.belowTransducer",
  wTemp: "environment.water.temperature",
  windSpeed: "environment.wind.speedApparent",
  windDir: "environment.wind.angleApparent",
  pressure: "environment.pressure",
};

// Helper function to get the current date and time in the format 'YYYY-MM-DD HH:MM:SS'
function getCurrentDateTime() {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0"); // Month is 0-indexed
  const day = String(now.getDate()).padStart(2, "0");

  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

module.exports = function (app) {
  let unsubscribes = [];

  function getKeyValue(key) {
    const data = app.getSelfPath(key);
    if (data == null) {
      return null;
    }

    return {
      value: data.value,
      unit: data.meta?.units,
    };
  }

  // Load offline data from the file
  function loadOfflineData() {
    try {
      if (fs.existsSync(offlineDataFilePath)) {
        const data = fs.readFileSync(offlineDataFilePath, "utf8");
        return JSON.parse(data);
      }
    } catch (err) {
      app.debug("Error loading offline data: " + err.message);
    }
    return [];
  }

  // Save offline data to the file
  function saveOfflineData(offlineDataQueue) {
    try {
      fs.writeFileSync(
        offlineDataFilePath,
        JSON.stringify(offlineDataQueue),
        "utf8"
      );
    } catch (err) {
      app.debug("Error saving offline data: " + err.message);
    }
  }

  // Append new data to the offline storage
  function appendToOfflineStorage(data) {
    let offlineDataQueue = loadOfflineData();
    offlineDataQueue.push(data);
    saveOfflineData(offlineDataQueue);
  }

  // Remove sent data from offline storage
  function clearOfflineData() {
    try {
      fs.writeFileSync(offlineDataFilePath, JSON.stringify([]), "utf8");
    } catch (err) {
      app.debug("Error clearing offline data: " + err.message);
    }
  }

  function sendDataToWebhook(data, webhookUrl, authKey) {
    const url = new URL(webhookUrl);
    url.searchParams.append("auth_key", authKey);

    fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    })
      .then((response) => {
        return response.text().then((text) => {
          if (!response.ok) {
            app.debug(
              `Failed to send data to webhook - Status: ${response.status}, Response: ${text}`
            );
            throw new Error(`HTTP error! status: ${response.status}`);
          } else {
            app.debug(
              `Data sent successfully - Status: ${response.status}, Response: ${text}`
            );
            isConnected = true;
            // Send any stored offline data
            resendOfflineData(webhookUrl, authKey);
            return text;
          }
        });
      })
      .catch((error) => {
        app.debug(`Error sending data to webhook: ${error.message}`);
        isConnected = false;
        appendToOfflineStorage(data); // Store data if sending failed
      });
  }

  // Resend any offline data
  function resendOfflineData(webhookUrl, authKey) {
    let offlineDataQueue = loadOfflineData();

    if (offlineDataQueue.length > 0) {
      app.debug("Resending offline data...");

      const url = new URL(webhookUrl);
      url.searchParams.append("auth_key", authKey);

      const sendPromises = offlineDataQueue.map((storedData) =>
        fetch(url.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(storedData),
        }).then((response) => {
          if (!response.ok) {
            throw new Error(
              `Failed to resend data - Status: ${response.status}`
            );
          }
          return response.text();
        })
      );

      Promise.allSettled(sendPromises)
        .then((results) => {
          const successfulSends = results.filter(
            (result) => result.status === "fulfilled"
          ).length;
          app.debug(
            `Successfully resent ${successfulSends} out of ${offlineDataQueue.length} stored data points`
          );

          if (successfulSends === offlineDataQueue.length) {
            clearOfflineData();
          } else {
            // Keep only the failed sends in the offline storage
            saveOfflineData(
              offlineDataQueue.filter(
                (_, index) => results[index].status === "rejected"
              )
            );
          }
        })
        .catch((error) => {
          app.debug(`Error in resending offline data: ${error.message}`);
        });
    }
  }

  // Calculate delay until the next interval (based on user setting)
  function getDelayUntilNextInterval(sendFreq) {
    const now = new Date();
    const currentMinutes = now.getMinutes();
    const nextInterval = Math.ceil(currentMinutes / sendFreq) * sendFreq;
    const minutesUntilNextInterval =
      nextInterval === currentMinutes ? 0 : nextInterval - currentMinutes;
    const millisecondsUntilNextInterval =
      minutesUntilNextInterval * 60 * 1000 -
      now.getSeconds() * 1000 -
      now.getMilliseconds();
    return millisecondsUntilNextInterval;
  }

  const plugin = {
    id: "msp-webhook",
    name: "Morvargh Sailing Project Webhook Exporter",
    description:
      "A plugin to send data from SignalK to a webhook. If the server looses connection to the webhook the plugin will store the entry in a local file as JSON data; once the connection is restored it will send the stored data to the hook for processing (at the next scheduled attempt) and if successfully sent delete the record.",

    start: (settings, restartPlugin) => {
      app.debug("Starting MSP Webhook plugin 1.2.3");
      pluginSettings = settings;

      const data = {};

      const subscriptionPaths = [];
      for (const [key, path] of Object.entries(KEYS)) {
        if (settings[key.split(".").pop()]) {
          subscriptionPaths.push({ path, period: settings.sendFreq * 60000 });
        }
      }

      const localSubscription = {
        context: "vessels.self",
        subscribe: subscriptionPaths.map((path) => ({
          path: path.path,
          policy: "instant",
        })),
      };

      app.subscriptionmanager.subscribe(
        localSubscription,
        unsubscribes,
        (subscriptionError) => {
          app.error("Subscription error: " + subscriptionError);
        },
        (delta) => {
          delta.updates.forEach((update) => {
            update.values.forEach((value) => {
              const key = Object.keys(KEYS).find((k) => KEYS[k] === value.path);
              if (key) {
                data[key] = {
                  value: value.value,
                  unit: app.getSelfPath(value.path)?.meta?.units,
                };
              }
            });
          });
        }
      );

      // Calculate the delay to the next multiple of the send frequency
      const initialDelay = getDelayUntilNextInterval(settings.sendFreq);

      setTimeout(() => {
        // Send data immediately after the initial delay
        const sendPeriodicData = () => {
          const dataToSend = {};

          for (const [key, path] of Object.entries(KEYS)) {
            if (settings[key.split(".").pop()]) {
              dataToSend[key] = data[key] || getKeyValue(path);
            }
          }

          // Add datetime to the data before sending
          dataToSend.datetime = getCurrentDateTime();

          // Always attempt to send data, regardless of isConnected status
          sendDataToWebhook(dataToSend, settings.webhookUrl, settings.authKey);
        };

        // Send data immediately
        sendPeriodicData();

        // Set interval to send data at user-defined intervals (e.g., every 10 minutes)
        setInterval(sendPeriodicData, settings.sendFreq * 60000); // settings.sendFreq is in minutes
      }, initialDelay);
    },

    stop: () => {
      app.debug("Stopping MSP Webhook plugin...");
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      unsubscribes = [];
    },

    schema: {
      type: "object",
      required: ["sendFreq", "webhookUrl", "authKey"],
      properties: {
        sendFreq: {
          type: "number",
          title:
            "How often do you want the plugin to send boat data to the webhook (in minutes)",
          default: 1,
        },
        webhookUrl: {
          type: "string",
          title: "Webhook URL",
          default: "",
        },
        authKey: {
          type: "string",
          title: "Authentication Key",
          default: "",
        },
        position: {
          type: "boolean",
          title: "Include Latitude & Longitude",
          default: false,
        },
        speed: {
          type: "boolean",
          title: "Include navigation.speedOverGround (SOG)",
          default: false,
        },
        heading: {
          type: "boolean",
          title: "Include navigation.headingTrue (True heading)",
          default: false,
        },
        log: {
          type: "boolean",
          title: "Include navigation.trip.log (LOG)",
          default: false,
        },
        depth: {
          type: "boolean",
          title: "Include environment.depth.belowTransducer (Depth)",
          default: false,
        },
        wTemp: {
          type: "boolean",
          title: "Include environment.water.temperature (Water Temp)",
          default: false,
        },
        windSpeed: {
          type: "boolean",
          title:
            "Include environment.wind.speedApparent (Apparent Wind Speed - kts)",
          default: false,
        },
        windDir: {
          type: "boolean",
          title:
            "Include environment.wind.angleApparent (Apparent Wind Speed - deg)",
          default: false,
        },
        pressure: {
          type: "boolean",
          title: "Include environment.pressure (Barometric Pressure)",
          default: false,
        },
      },
    },
  };

  return plugin;
};
