const express = require("express")
const http = require("http")
const socketIo = require("socket.io")
const cors = require("cors")
const { v4: uuidv4 } = require("uuid")

const app = express()
const server = http.createServer(app)

// Проверка разрешенных доменов
const allowedDomains = [
  "https://actogram.vercel.app",
  "https://actogram.onrender.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]

const io = socketIo(server, {
  cors: {
    origin: (origin, callback) => {
      // Разрешаем запросы без origin (мобильные приложения, Postman и т.д.)
      if (!origin) return callback(null, true)

      const isAllowed = allowedDomains.some((domain) => origin.startsWith(domain))
      if (isAllowed) {
        callback(null, true)
      } else {
        callback(new Error("Not allowed by CORS - Domain access restricted"))
      }
    },
    methods: ["GET", "POST"],
  },
})

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true)

      const isAllowed = allowedDomains.some((domain) => origin.startsWith(domain))
      if (isAllowed) {
        callback(null, true)
      } else {
        callback(new Error("Not allowed by CORS"))
      }
    },
  }),
)

app.use(express.json())

// Хранилище данных в памяти (в продакшене используй базу данных)
const users = new Map()
const chats = new Map()
const messages = new Map()

// Создаем общий чат при запуске
const generalChatId = "general"
chats.set(generalChatId, {
  id: generalChatId,
  name: "Общий чат",
  isGroup: true,
  participants: [],
  createdAt: new Date(),
})
messages.set(generalChatId, [])

// Middleware для проверки домена
const checkDomain = (req, res, next) => {
  const origin = req.get("origin") || req.get("host")
  const isAllowed = allowedDomains.some(
    (domain) =>
      origin && (origin.includes("vercel.app") || origin.includes("render.com") || origin.includes("localhost")),
  )

  if (!isAllowed) {
    return res.status(403).json({ error: "Domain access restricted" })
  }
  next()
}

// API Routes
app.get("/api/health", checkDomain, (req, res) => {
  res.json({
    status: "Actogram server is running",
    timestamp: new Date().toISOString(),
    activeUsers: users.size,
    activeChats: chats.size,
  })
})

app.get("/api/chats", checkDomain, (req, res) => {
  const chatList = Array.from(chats.values()).map((chat) => ({
    ...chat,
    lastMessage: messages.get(chat.id)?.slice(-1)[0] || null,
    messageCount: messages.get(chat.id)?.length || 0,
  }))
  res.json(chatList)
})

app.get("/api/messages/:chatId", checkDomain, (req, res) => {
  const { chatId } = req.params
  const chatMessages = messages.get(chatId) || []
  res.json(chatMessages)
})

// Socket.IO обработка соединений
io.on("connection", (socket) => {
  console.log("Новое подключение:", socket.id)

  // Проверка домена для WebSocket
  const origin = socket.handshake.headers.origin
  const isAllowed = allowedDomains.some(
    (domain) =>
      origin && (origin.includes("vercel.app") || origin.includes("render.com") || origin.includes("localhost")),
  )

  if (!isAllowed) {
    console.log("Отклонено подключение с домена:", origin)
    socket.disconnect()
    return
  }

  // Регистрация пользователя
  socket.on("register", (userData) => {
    const user = {
      id: userData.id || uuidv4(),
      username: userData.username,
      socketId: socket.id,
      isOnline: true,
      joinedAt: new Date(),
    }

    users.set(socket.id, user)

    // Добавляем пользователя в общий чат
    const generalChat = chats.get(generalChatId)
    if (generalChat && !generalChat.participants.find((p) => p.id === user.id)) {
      generalChat.participants.push(user)
    }

    socket.join(generalChatId)

    // Уведомляем всех о новом пользователе
    socket.to(generalChatId).emit("user_joined", {
      user: user,
      message: `${user.username} присоединился к чату`,
    })

    // Отправляем список активных пользователей
    const activeUsers = Array.from(users.values())
    io.emit("users_update", activeUsers)

    console.log(`Пользователь ${user.username} зарегистрирован`)
  })

  // Присоединение к чату
  socket.on("join_chat", (chatId) => {
    socket.join(chatId)
    console.log(`Пользователь присоединился к чату: ${chatId}`)
  })

  // Отправка сообщения
  socket.on("send_message", (messageData) => {
    const user = users.get(socket.id)
    if (!user) return

    const message = {
      id: uuidv4(),
      senderId: user.id,
      senderName: user.username,
      content: messageData.content,
      chatId: messageData.chatId,
      timestamp: new Date(),
      type: messageData.type || "text",
    }

    // Сохраняем сообщение
    if (!messages.has(messageData.chatId)) {
      messages.set(messageData.chatId, [])
    }
    messages.get(messageData.chatId).push(message)

    // Отправляем сообщение всем в чате
    io.to(messageData.chatId).emit("new_message", message)

    console.log(`Сообщение от ${user.username} в чат ${messageData.chatId}`)
  })

  // Пользователь печатает
  socket.on("typing", (data) => {
    const user = users.get(socket.id)
    if (user) {
      socket.to(data.chatId).emit("user_typing", {
        userId: user.id,
        username: user.username,
        chatId: data.chatId,
      })
    }
  })

  // Пользователь перестал печатать
  socket.on("stop_typing", (data) => {
    const user = users.get(socket.id)
    if (user) {
      socket.to(data.chatId).emit("user_stop_typing", {
        userId: user.id,
        chatId: data.chatId,
      })
    }
  })

  // Отключение пользователя
  socket.on("disconnect", () => {
    const user = users.get(socket.id)
    if (user) {
      // Удаляем пользователя из общего чата
      const generalChat = chats.get(generalChatId)
      if (generalChat) {
        generalChat.participants = generalChat.participants.filter((p) => p.id !== user.id)
      }

      // Уведомляем о выходе пользователя
      socket.to(generalChatId).emit("user_left", {
        user: user,
        message: `${user.username} покинул чат`,
      })

      users.delete(socket.id)

      // Обновляем список активных пользователей
      const activeUsers = Array.from(users.values())
      io.emit("users_update", activeUsers)

      console.log(`Пользователь ${user.username} отключился`)
    }
  })
})

const PORT = process.env.PORT || 3001

server.listen(PORT, () => {
  console.log(`🚀 Actogram server запущен на порту ${PORT}`)
  console.log(`📱 Разрешенные домены: ${allowedDomains.join(", ")}`)
  console.log(`💬 Общий чат создан с ID: ${generalChatId}`)
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Получен SIGTERM, завершаем сервер...")
  server.close(() => {
    console.log("Сервер остановлен")
    process.exit(0)
  })
})
