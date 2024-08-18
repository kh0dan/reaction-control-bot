const dotenv = require('dotenv');
dotenv.config();
const { Telegraf } = require('telegraf');
const rateLimit = require('telegraf-ratelimit');
const cron = require('node-cron');
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    waitForConnections: true,
    connectionLimit: 100,
    queueLimit: 0
});

const bot = new Telegraf(process.env.BOT_TOKEN);

const limitConfig = {
    window: 6000, 
    limit: 50
};

bot.start(async (ctx) => {
    try {
        if(ctx.chat.type === 'private') {
            return ctx.react('❤‍🔥');
        } else if(ctx.chat.type === 'supergroup') {
            const isValid = await validChat(ctx);
            if(!isValid) return;

            return ctx.react('❤‍🔥');
        }
    } catch (error) {
        console.error(error);
    }
});

bot.on('message', async (ctx) => {
    try {
        const isValid = await validChat(ctx);
        if(!isValid) return;

        const message = ctx.message.text || ctx.message.caption;

        if(!message || message.length < 10) return;

        await executeQuery(`INSERT INTO messages(chat_id, message_id, from_id, date) VALUES(?, ?, ?, ?)`, [ctx.update.message.chat.id, ctx.update.message.message_id, ctx.update.message.from.id, ctx.update.message.date]);
    } catch (error) {
        console.error(error);
    }
});

bot.on('message_reaction', async (ctx) => {
    try {
        if(ctx.chat.type !== 'supergroup') return;
        if(ctx.chat.id !== parseInt(process.env.CHAT_ID)) return;
        if(ctx.update.message_reaction.user.id === ctx.botInfo.id) return;
        if(!ctx.update.message_reaction.new_reaction.length) return;

        const [rows] = await executeQuery('SELECT * FROM messages WHERE message_id = ? AND chat_id = ?', [ctx.update.message_reaction.message_id, ctx.update.message_reaction.chat.id]);
        if(!rows) return;

        const rowsDelete = await executeQuery('DELETE FROM messages WHERE message_id = ? AND chat_id = ?', [ctx.update.message_reaction.message_id, ctx.update.message_reaction.chat.id]);
        if(rowsDelete.affectedRows) return ctx.react('✍️');
    } catch (error) {
        console.error(error);
    }
});

bot.use(rateLimit(limitConfig));

bot.launch({
    allowedUpdates: ['message', 'message_reaction']
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

async function executeQuery(query, params) {
    const connection = await pool.getConnection();
    try {
        const [results] = await connection.query(query, params);
        return results;
    } finally {
        connection.release();
    }
};

async function validChat(ctx) {
    try {
        if(ctx.chat.type !== 'supergroup') return;
        if(ctx.chat.id !== parseInt(process.env.CHAT_ID)) return;
        if(ctx.from.id === ctx.botInfo.id) return;
        if(!ctx.update.message.reply_to_message) return;
        if(!ctx.update.message.reply_to_message.is_topic_message || !ctx.update.message.reply_to_message.forum_topic_created) return;
        if(ctx.update.message.reply_to_message.forum_topic_created.name !== process.env.TOPIC_NAME) return;
    
        return true;
    } catch (error) {
        console.error(error);
    }
};

async function processMessages() {
    const currentTime = Math.floor(Date.now() / 1000);
    const messages = await executeQuery('SELECT * FROM messages');

    for (const message of messages) {
        const timeElapsed = currentTime - message.date;
        const hoursElapsed = Math.floor(timeElapsed / (60 * 60));
        const daysElapsed = Math.floor(timeElapsed / (60 * 60 * 24));

        if (daysElapsed >= 1 && daysElapsed <= 7) {
            if (daysElapsed > message.notifications_sent) {
                try {
                    const deleteMessage = await bot.telegram.sendMessage(message.chat_id, `Необходимо оставить реакцию на сообщение! <b>(прошло ${hoursElapsed}ч)</b>`, {reply_to_message_id: message.message_id, parse_mode: 'HTML'});
                    if(!deleteMessage.reply_to_message) {
                        await executeQuery('DELETE FROM messages WHERE chat_id = ? AND message_id = ?', [message.chat_id, message.message_id]);
                        return bot.telegram.deleteMessage(message.chat_id, deleteMessage.message_id);
                    }
                    await executeQuery('UPDATE messages SET notifications_sent = ? WHERE chat_id = ? AND message_id = ?', [daysElapsed, message.chat_id, message.message_id]);
                } catch (error) {
                    if (error) {
                        await executeQuery('DELETE FROM messages WHERE chat_id = ? AND message_id = ?', [message.chat_id, message.message_id]);
                    }
                }
            }
        } else if (daysElapsed > 7) {
            const rowsDelete = await executeQuery('DELETE FROM messages WHERE chat_id = ? AND message_id = ?', [message.chat_id, message.message_id]);
            if (rowsDelete.affectedRows) {
                await bot.telegram.sendMessage(message.chat_id, `Прошло 7 дней, реакция так и не была оставлена, упоминание по этому сообщению отключено.`);
            }
        }
    }
}

cron.schedule('* * * * *', async () => {
    try {
        await processMessages();
    } catch (error) {
        console.error(error);
    }
});