 const mineflayer = require('mineflayer');
const { Webhook } = require('discord-webhook-node');
const Movements = require('mineflayer-pathfinder').Movements;
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const { GoalBlock, GoalXZ } = require('mineflayer-pathfinder').goals;
const config = require('./settings.json');
console.log('config', config)
const webhook = new Webhook(config.webhook);
const loggers = require('./logging.js');
if (!config) {
    throw new Error("Could not load settings.json");
}

const logger = loggers.logger;
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.status(200).send('Bot is running');
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

function createBot() {
    const bot = mineflayer.createBot({
        username: config['bot-account']['username'],
        password: config['bot-account']['password'],
        auth: config['bot-account']['type'],
        host: config.server.ip,
        port: config.server.port,
        version: config.server.version,
    });
    console.log('bot', bot)

    if (bot) {
        bot.loadPlugin(pathfinder);
        const mcData = require('minecraft-data')(bot.version);
        const defaultMove = new Movements(bot, mcData);
        bot.settings.colorsEnabled = false;
        bot.pathfinder.setMovements(defaultMove);
    }


    bot.once('spawn', () => {
        console.log('Bot created correctly')
        logger.info("Bot joined to the server");
        webhook.send({
            content: 'Bot joined to the server',
            username: 'Bot Status',
        });

        // Send status every 1 minute
        setInterval(() => {
            const pos = bot.entity.position;
            webhook.send({
                content: `Bot is online. Current position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`,
                username: 'Bot Status',
            });
        }, 60000); // 60000 ms = 1 minute

        if (config.utils['auto-auth'].enabled) {
            logger.info('Started auto-auth module');

            let password = config.utils['auto-auth'].password;
            setTimeout(() => {
                bot.chat(`/register ${password} ${password}`);
                bot.chat(`/login ${password}`);
            }, 500);

            logger.info(`Authentication commands executed`);
        }

        if (config.utils['chat-messages'].enabled) {
            logger.info('Started chat-messages module');

            let messages = config.utils['chat-messages']['messages'];

            if (config.utils['chat-messages'].repeat) {
                let delay = config.utils['chat-messages']['repeat-delay'];
                let i = 0;

                setInterval(() => {
                    bot.chat(`${messages[i]}`);

                    if (i + 1 === messages.length) {
                        i = 0;
                    } else i++;
                }, delay * 1000);
            } else {
                messages.forEach((msg) => {
                    bot.chat(msg);
                });
            }
        }

        const pos = config.position;

        if (config.position.enabled) {
            logger.info(
                `Starting moving to target location (${pos.x}, ${pos.y}, ${pos.z})`
            );
            bot.pathfinder.setGoal(new GoalBlock(pos.x, pos.y, pos.z));
        }

        if (config.utils['anti-afk'].enabled) {
            if (config.utils['anti-afk'].sneak) {
                bot.setControlState('sneak', true);
            }

            if (config.utils['anti-afk'].jump) {
                bot.setControlState('jump', true);
            }

            if (config.utils['anti-afk']['hit'].enabled) {
                let delay = config.utils['anti-afk']['hit']['delay'];
                let attackMobs = config.utils['anti-afk']['hit']['attack-mobs']

                setInterval(() => {
                    if (attackMobs) {
                        let entity = bot.nearestEntity(e => e.type !== 'object' && e.type !== 'player'
                            && e.type !== 'global' && e.type !== 'orb' && e.type !== 'other');

                        if (entity) {
                            bot.attack(entity);
                            return
                        }
                    }

                    bot.swingArm("right", true);
                }, delay);
            }

            if (config.utils['anti-afk'].rotate) {
                setInterval(() => {
                    bot.look(bot.entity.yaw + 1, bot.entity.pitch, true);
                }, 100);
            }

            if (config.utils['anti-afk']['circle-walk'].enabled) {
                let radius = config.utils['anti-afk']['circle-walk']['radius']
                circleWalk(bot, radius);
            }
        }
    });

    bot.on('chat', (username, message) => {
        if (config.utils['chat-log']) {
            logger.info(`<${username}> ${message}`);
        }
         if (username === bot.username) return;
        webhook.send({
            content: `<${username}> ${message}`,
            username: 'Minecraft Chat Log',
        });
    });

    bot.on('goal_reached', () => {
        if (config.position.enabled) {
            logger.info(
                `Bot arrived to target location. ${bot.entity.position}`
            );
        }
    });

    bot.on('death', () => {
        logger.warn(
            `Bot has been died and was respawned at ${bot.entity.position}`
        );
        webhook.send({
            content: `Bot has been died and was respawned at ${bot.entity.position}`,
            username: 'Bot Status',
        });
    });

    if (config.utils['auto-reconnect']) {
        bot.on('end', () => {
            logger.info("Bot disconnected, reconnecting...")
            webhook.send({
                content: "Bot disconnected, reconnecting...",
                username: 'Bot Status',
            });
            setTimeout(() => {
                createBot();
            }, config.utils['auto-reconnect-delay']);
        });
    }

    bot.on('kicked', (reason) => {
        let reasonText = JSON.parse(reason).text;
        if (reasonText === '' && JSON.parse(reason).extra) {
            reasonText = JSON.parse(reason).extra[0].text
        }
        reasonText = reasonText.replace(/§./g, '');

        logger.warn(`Bot was kicked from the server. Reason: ${reasonText}`)
        webhook.send({
            content: `Bot was kicked from the server. Reason: ${reasonText}`,
            username: 'Bot Status',
        });
    }
    );

    bot.on('error', (err) => {
        logger.error(`${err.message}`);
        webhook.send({
            content: `Bot has an error: ${err.message}`,
            username: 'Bot Status',
        });
    });
}

function circleWalk(bot, radius) {
    // Make bot walk in square with center in bot's  wthout stopping
    return new Promise(() => {
        const pos = bot.entity.position;
        const x = pos.x;
        const y = pos.y;
        const z = pos.z;

        const points = [
            [x + radius, y, z],
            [x, y, z + radius],
            [x - radius, y, z],
            [x, y, z - radius],
        ];

        let i = 0;
        setInterval(() => {
            if (i === points.length) i = 0;
            bot.pathfinder.setGoal(new GoalXZ(points[i][0], points[i][2]));
            i++;
        }, 1000);
    });
}

createBot();
