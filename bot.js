const mineflayer = require('mineflayer');
const { Webhook } = require('discord-webhook-node');
const Movements = require('mineflayer-pathfinder').Movements;
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const { GoalBlock, GoalXZ } = require('mineflayer-pathfinder').goals;
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');

require('dotenv').config();

const webhook = new Webhook(process.env.WEBHOOK_URL);
const loggers = require('./logging.js');

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
    const options = {
        host: process.env.SERVER_IP,                    
        port: process.env.SERVER_PORT ? parseInt(process.env.SERVER_PORT) : 25565,                 
        version: process.env.SERVER_VERSION || '1.19',              
        username: process.env.BOT_USERNAME,       
        password: process.env.BOT_PASSWORD,       
        auth: process.env.BOT_TYPE || 'mojang'            
    }

    // console.log('Bot creating with options:', options)
    try {
        var bot = mineflayer.createBot(options)
        // console.log('bot', bot)
    } catch (err) {
        console.error("Error creating bot:", err)
        return
    }

    if (bot && bot.settings && bot.pathfinder) {
        bot.loadPlugin(pathfinder);
        const mcData = require('minecraft-data')(bot.version);
        if (mcData) {
            const defaultMove = new Movements(bot, mcData);
            if(defaultMove) bot.pathfinder.setMovements(defaultMove);
        }
        if (bot.settings) bot.settings.colorsEnabled = false;
    }

    // Add logging before the problematic line
    bot.on('game_state_changed', (state) => {
        console.log('Game state changed to:', state);
        console.log('bot.game:', bot.game);
        console.log('bot.registry:', bot.registry);
        if (bot.registry) {
            console.log('bot.registry.dimensionsByName:', bot.registry.dimensionsByName);
        }        
        if (state === 'respawn') {
            console.log('Attempting to access dimension data during respawn:');
            console.log('bot.game.dimension:', bot.game.dimension);
            console.log('bot.registry:', bot.registry);
            if (bot.registry) {
                console.log('bot.registry.dimensionsByName:', bot.registry.dimensionsByName);
            }
        }
    });

    bot.once('spawn', () => {
        console.log('Bot created correctly')
        logger.info("Bot joined to the server");
        webhook.send({
            content: 'Bot joined to the server',
            username: 'Bot Status',
        });

        mineflayerViewer(bot, { port: 3007, firstPerson: true });

        // Read these settings from environment variables if needed, or keep them in settings.json if not sensitive
        // const config = require('./settings.json'); 

        if (process.env.AUTO_AUTH_ENABLED === 'true') {
            logger.info('Started auto-auth module');

            let password = process.env.AUTO_AUTH_PASSWORD;
            setTimeout(() => {
                bot.chat(`/register ${password} ${password}`);
                bot.chat(`/login ${password}`);
            }, 500);

            logger.info(`Authentication commands executed`);
        }

        if (process.env.CHAT_MESSAGES_ENABLED === 'true') {
            logger.info('Started chat-messages module');

            let messages = process.env.CHAT_MESSAGES ? JSON.parse(process.env.CHAT_MESSAGES) : [];

            if (process.env.CHAT_MESSAGES_REPEAT === 'true') {
                let delay = process.env.CHAT_MESSAGES_REPEAT_DELAY ? parseInt(process.env.CHAT_MESSAGES_REPEAT_DELAY) : 60;
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

        // Read position from environment variables if needed, or keep them in settings.json
        // const pos = config.position;

        if (process.env.POSITION_ENABLED === 'true') {
             const posX = process.env.POSITION_X ? parseInt(process.env.POSITION_X) : 0;
             const posY = process.env.POSITION_Y ? parseInt(process.env.POSITION_Y) : 0;
             const posZ = process.env.POSITION_Z ? parseInt(process.env.POSITION_Z) : 0;

            logger.info(
                `Starting moving to target location (${posX}, ${posY}, ${posZ})`
            );
            bot.pathfinder.setGoal(new GoalBlock(posX, posY, posZ));
        }

        if (process.env.ANTI_AFK_ENABLED === 'true') {
            if (process.env.ANTI_AFK_SNEAK === 'true') {
                bot.setControlState('sneak', true);
            }

            if (process.env.ANTI_AFK_JUMP === 'true') {
                bot.setControlState('jump', true);
            }

            if (process.env.ANTI_AFK_HIT_ENABLED === 'true') {
                let delay = process.env.ANTI_AFK_HIT_DELAY ? parseInt(process.env.ANTI_AFK_HIT_DELAY) : 1000;
                let attackMobs = process.env.ANTI_AFK_HIT_ATTACK_MOBS === 'true';

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

            if (process.env.ANTI_AFK_ROTATE === 'true') {
                setInterval(() => {
                    bot.look(bot.entity.yaw + 1, bot.entity.pitch, true);
                }, 100);
            }

            if (process.env.ANTI_AFK_CIRCLE_WALK_ENABLED === 'true') {
                let radius = process.env.ANTI_AFK_CIRCLE_WALK_RADIUS ? parseInt(process.env.ANTI_AFK_CIRCLE_WALK_RADIUS) : 2;
                circleWalk(bot, radius);
            }
        }
    });

    bot.on('chat', (username, message) => {
        if (process.env.CHAT_LOG === 'true') {
            logger.info(`<${username}> ${message}`);
        }
         if (username === bot.username) return;        
    });

    bot.on('goal_reached', () => {
        if (process.env.POSITION_ENABLED === 'true') {
            logger.info(
                `Bot arrived to target location. ${bot.entity.position}`
            );
        }
    });

    bot.on('death', () => {
        logger.warn(
            `Bot has been died and was respawned at ${bot.entity.position}`
        );
    });

    if (process.env.AUTO_RECONNECT === 'true') {
        bot.on('end', () => {
            logger.info("Bot disconnected, reconnecting...")
            setTimeout(() => {
                createBot();
            }, process.env.AUTO_RECONNECT_DELAY ? parseInt(process.env.AUTO_RECONNECT_DELAY) : 5000);
        });
    }

    bot.on('kicked', (reason) => {
        let reasonText = JSON.parse(reason).text;
        if (reasonText === '' && JSON.parse(reason).extra) {
            reasonText = JSON.parse(reason).extra[0].text
        }
        reasonText = reasonText.replace(/§./g, '');

        logger.warn(`Bot was kicked from the server. Reason: ${reasonText}`)
    }
    );

    bot.on('error', (err) => {
        logger.error(`${err.message}`);
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
