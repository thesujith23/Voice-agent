const fs = require('fs');
const path = require('path');

const agentsDir = path.join(__dirname, '..', 'agents');

// Ensure agents directory exists
if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
}

class AgentStorage {
    static generateId(name) {
        return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }

    static getFilePath(id) {
        return path.join(agentsDir, `${id}.json`);
    }

    static listAgents() {
        const files = fs.readdirSync(agentsDir);
        return files
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const id = f.replace('.json', '');
                return this.getAgent(id);
            })
            .filter(a => a !== null);
    }

    static getAgent(id) {
        const filePath = this.getFilePath(id);
        if (!fs.existsSync(filePath)) return null;
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            return { id, ...JSON.parse(data) };
        } catch (e) {
            console.error(`Error reading agent ${id}:`, e);
            return null;
        }
    }

    static saveAgent(data) {
        // If an ID wasn't provided, generate one from the name. 
        // If the file already exists, append a timestamp.
        let id = data.id || this.generateId(data.agentName || 'new-agent');
        let filePath = this.getFilePath(id);
        
        if (!data.id && fs.existsSync(filePath)) {
            id = `${id}-${Date.now()}`;
            filePath = this.getFilePath(id);
        }

        const agentData = { ...data };
        delete agentData.id; // Don't store ID inside the file since it's the filename

        fs.writeFileSync(filePath, JSON.stringify(agentData, null, 2), 'utf8');
        return { id, ...agentData };
    }

    static deleteAgent(id) {
        const filePath = this.getFilePath(id);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
        return false;
    }
}

module.exports = AgentStorage;
