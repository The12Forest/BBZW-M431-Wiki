import log from './../../function/log.js';
const console = { log: log('WebSocket') };
let io_instance = null
let gameGroups = {}


function setupSocket(io) {
    io_instance = io

    io.on('connection', (socket) => {
        socket.on('join-game', (data) => {
            const { gameId, groupId, playerId } = data

            if (!gameGroups[gameId]) {
                gameGroups[gameId] = { group1: [], group2: [] }
            }

            if (!gameGroups[gameId][groupId].includes(socket.id)) {
                gameGroups[gameId][groupId].push(socket.id)
            }

            const count = gameGroups[gameId][groupId].length;

            socket.join(`game-${gameId}-${groupId}`)
            socket.gameId = gameId
            socket.groupId = groupId
            socket.playerId = playerId

            console.log(`Player ${playerId} joined ${gameId}/${groupId}`)
            console.log(`Game state:`, JSON.stringify(gameGroups[gameId]))

            io.to(`game-${gameId}-${groupId}`).emit('player-joined', {
                playerId: playerId,
                socketId: socket.id,
                group: groupId,
                currentPlayerCount: count
            })
        })

        socket.on('group-message', (message) => {
            io.to(`game-${socket.gameId}-${socket.groupId}`).emit('receive-message', {
                playerId: socket.playerId,
                message: message,
                group: socket.groupId,
                timestamp: new Date()
            })
        })

        socket.on('group-update', (data) => {
            io.to(`game-${socket.gameId}-${socket.groupId}`).emit('group-state-update', {
                group: socket.groupId,
                data: data
            })
        })

        socket.on('notify-other-group', (data) => {
            const otherGroup = socket.groupId === 'group1' ? 'group2' : 'group1'
            io.to(`game-${socket.gameId}-${otherGroup}`).emit('opponent-action', data)
        })

        socket.on('disconnect', () => {
            if (socket.gameId && socket.groupId) {
                const groupPlayers = gameGroups[socket.gameId][socket.groupId];
                const index = groupPlayers.indexOf(socket.id);

                if (index > -1) {
                    groupPlayers.splice(index, 1);
                }

                const currentPlayerCount = groupPlayers.length;

                io.to(`game-${socket.gameId}-${socket.groupId}`).emit('player-left', {
                    playerId: socket.playerId,
                    group: socket.groupId,
                    currentPlayerCount: currentPlayerCount
                });


            }
        });
    })
}

export { gameGroups, setupSocket, io_instance }