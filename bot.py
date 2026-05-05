"""
Pearl Crew — Discord Multi-Agent Bot
Entry point. Loads all agents, maps channels, starts the bot.
"""

import discord
import os
from dotenv import load_dotenv
from agents import AGENTS, get_agent_by_name
from router import Pearl
from history import HistoryManager
from commands import is_command, handle_command

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN")

# Map your actual Discord channel names to agent names
# Edit these to match your server's channel names
CHANNEL_MAP = {
    "pearl":  "pearl",
    "corey":  "corey",
    "midas":  "midas",
    "rain":   "rain",
    "levy":   "levy",
    "hub":    None,  # Pearl routes automatically here
}

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)

history = HistoryManager()
pearl_router = Pearl(history)


@client.event
async def on_ready():
    print(f"Pearl Crew online as {client.user}")
    for name, ch in CHANNEL_MAP.items():
        print(f"  #{name} → agent: {ch or 'pearl-routed'}")


@client.event
async def on_message(message):
    if message.author.bot:
        return

    channel_name = message.channel.name.lower()
    if channel_name not in CHANNEL_MAP:
        return

    user_id = str(message.author.id)
    user_name = message.author.display_name
    content = message.content.strip()

    if not content:
        return

    async with message.channel.typing():
        try:
            # Handle !crew commands from any channel
            if is_command(content):
                response = await handle_command(content, str(message.author.id), message.author.display_name)
                await message.channel.send(response)
                return

            assigned_agent_name = CHANNEL_MAP[channel_name]

            if assigned_agent_name is None:
                # Hub channel — Pearl decides who handles it
                response = await pearl_router.route_and_respond(
                    user_id=user_id,
                    user_name=user_name,
                    content=content,
                )
            else:
                # Direct agent channel
                agent = get_agent_by_name(assigned_agent_name)
                response = await agent.respond(
                    user_id=user_id,
                    user_name=user_name,
                    content=content,
                    history=history,
                )

            # Split long responses for Discord's 2000 char limit
            for chunk in split_response(response):
                await message.channel.send(chunk)

        except Exception as e:
            await message.channel.send(f"⚠️ Something went wrong: `{e}`")
            print(f"Error in #{channel_name}: {e}")


def split_response(text: str, limit: int = 1900) -> list[str]:
    """Split response into Discord-safe chunks."""
    if len(text) <= limit:
        return [text]
    chunks = []
    while text:
        chunks.append(text[:limit])
        text = text[limit:]
    return chunks


if __name__ == "__main__":
    client.run(TOKEN)
