// === app.js ===

// === КОНФИГУРАЦIЯ ===
const API_BASE_URL = "";
const ANIMATION_DURATION = 500; // Длительность анимации хода (мс)
const DICE_ROLL_DURATION = 800; // Длительность анимации броска костей (мс)

// ГЛОБАЛЬНЫЕ КОНСТАНТЫ СЖАТИЯ:
const COMPRESS_AFTER_N_CHECKERS = 5;
const BASE_GAP_PERCENT = 5;
const MAX_OVERLAP_PERCENT = -80;
const CHECKERS_TO_MAX_COMPRESSION = 5;

// === ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ===
let socket = null;
let currentGameId = null;
let currentGameState = {
    board_state: [],
    dice: [],
    possible_turns: [],
    turn: 0,
    borne_off_white: 0,
    borne_off_black: 0,
    can_undo: false,
};
let selectedCheckerPoint = null;
let isAnimating = false;
let playerSign = 1; // По умолчанию мы белые (1).

// ПЕРЕМЕННЫЕ ДЛЯ СТЕКОВЫХ ХОДОВ
let clientMoveQueue = [];
let isProcessingQueue = false;

// Переменная для фейл-сейфа "анти-залипания"
let animationStartTime = 0;

// === Элементы DOM ===
const loginScene = document.getElementById("login-scene");
const lobbyScene = document.getElementById("lobby-scene");
const gameScene = document.getElementById("game-scene");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const loginBtn = document.getElementById("login-btn");
const registerBtn = document.getElementById("register-btn");
const messageDisplay = document.getElementById("message-display");
const userGreeting = document.getElementById("user-greeting");
const userRating = document.getElementById("user-rating");
const logoutBtn = document.getElementById("logout-btn");
const startPveBtn = document.getElementById("start-pve-btn");

// (!!!) ИСПРАВЛЕНО: Четкое определение панелей согласно HTML структуре (Белые внизу)
const gameHeader = {
    // White - Нижняя панель
    whiteName: document.getElementById("player-white-name"),
    whiteInfo: document.getElementById("player-white-info"),
    // Black - Верхняя панель
    blackName: document.getElementById("player-black-name"),
    blackInfo: document.getElementById("player-black-info"),
};
const gameStatus = document.getElementById("game-status");
const boardContainer = document.getElementById("board-container");
const boardWrapper = document.getElementById("board-wrapper");
const diceArea = document.getElementById("dice-area");
const rollDiceBtn = document.getElementById("roll-dice-btn");
const leaveGameBtn = document.getElementById("leave-game-btn");
const finishTurnBtn = document.getElementById("finish-turn-btn");
const undoBtn = document.getElementById("undo-btn");

// === Аудио (Без изменений) ===
const sounds = {
    move: document.getElementById("sound-move"),
    roll: document.getElementById("sound-roll"),
    notify: document.getElementById("sound-notify"),
    error: document.getElementById("sound-error"),
    hit: document.getElementById("sound-hit"),
};

function playSound(soundName) {
    if (sounds[soundName] && sounds[soundName].readyState >= 2) {
        sounds[soundName].currentTime = 0;
        sounds[soundName]
            .play()
            .catch((e) => console.log("Audio playback prevented:", e));
    }
}

// === Хранилище (Storage) и API (Без изменений) ===
const storage = {
    saveToken: (token) => localStorage.setItem("authToken", token),
    getToken: () => localStorage.getItem("authToken"),
    clearToken: () => localStorage.removeItem("authToken"),
    savePlayerData: (data) =>
        localStorage.setItem("playerData", JSON.stringify(data)),
    getPlayerData: () => JSON.parse(localStorage.getItem("playerData")),
    clearPlayerData: () => localStorage.removeItem("playerData"),
};

async function apiRequest(endpoint, method, data = null, token = null) {
    const url = API_BASE_URL + endpoint;
    const options = {
        method: method,
        headers: { "Content-Type": "application/json" },
    };
    if (data) {
        options.body = JSON.stringify(data);
    }
    if (token) {
        options.headers["Authorization"] = `Bearer ${token}`;
    }
    try {
        const response = await fetch(url, options);
        if (response.status === 204) return { status: "success" };
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.message || "Ошибка сервера");
        }
        return result;
    } catch (error) {
        console.error(`Ошибка API [${method} ${endpoint}]:`, error);
        return { status: "error", message: error.message };
    }
}

// === Вспомогательные функции ===
function showMessage(text, type = "error") {
    messageDisplay.textContent = text;
    messageDisplay.className =
        type === "success" ? "message success" : "message";
}

function showScene(sceneId) {
    const activeScene = document.querySelector(".scene.active");
    if (activeScene) {
        activeScene.classList.remove("active");
    }
    requestAnimationFrame(() => {
        const targetScene = document.getElementById(sceneId);
        if (targetScene) {
            targetScene.classList.add("active");
        }
    });
}

/**
 * ХЕЛПЕР: Является ли точка "выводом" для Белых
 */
function isWhiteBearingOffPoint(point) {
    // Белые (1) - точки > 24 (кроме 25, бара черных)
    return point > 24 && point != 25;
}

/**
 * ХЕЛПЕР: Является ли точка "выводом" для Черных
 */
function isBlackBearingOffPoint(point) {
    // Черные (-1) - точки < 1 (кроме 0, бара белых)
    return point < 1 && point != 0;
}

/**
 * ХЕЛПЕР: Является ли точка "выводом" для игрока
 */
function isBearingOffPoint(point, sign) {
    return sign == 1
        ? isWhiteBearingOffPoint(point)
        : isBlackBearingOffPoint(point);
}

/**
 * ХЕЛПЕР: Фейл-сейф от "залипания" UI (Без изменений)
 */
function checkAnimationFailsafe() {
    if (isAnimating) {
        const animationDuration = Date.now() - animationStartTime;
        if (animationStartTime > 0 && animationDuration > 3000) {
            // 3 секунды
            console.warn(
                `[FAILSAFE] UI 'stuck' for ${animationDuration}ms. Forcing sync.`
            );
            isAnimating = false;
            animationStartTime = 0;
            if (socket) socket.emit("request_full_game_sync");

            return true;
        }
        return true; // "Да, мы анимируемся, блокируй"
    }
    return false; // "Нет, мы не анимируемся, продолжай"
}

// === Обработчики событий (Логин/Выход) (Без изменений) ===
async function handleLogin(e) {
    // ... (Без изменений)
    e.preventDefault();
    const username = usernameInput.value;
    const password = passwordInput.value;
    if (!username || !password) {
        showMessage("Введите логин и пароль");
        return;
    }
    loginBtn.disabled = true;
    showMessage("Входим...", "success");
    const result = await apiRequest("/login", "POST", { username, password });
    loginBtn.disabled = false;

    if (result.status === "success") {
        storage.saveToken(result.access_token);
        storage.savePlayerData(result.player_data);
        enterLobby(result.player_data);
    } else {
        showMessage(result.message || "Неверный логин и пароль");
    }
}
async function handleRegister() {
    // ... (Без изменений)
    const username = usernameInput.value;
    const password = passwordInput.value;
    if (!username || !password) {
        showMessage("Введите логин и пароль");
        return;
    }
    registerBtn.disabled = true;
    showMessage("Регистрация...", "success");
    const result = await apiRequest("/register", "POST", {
        username,
        password,
    });
    registerBtn.disabled = false;

    if (result.status === "success") {
        showMessage("Регистрация успешна! Теперь можете войти.", "success");
        passwordInput.value = "";
    } else {
        showMessage(result.message || "Ошибка регистрации");
    }
}

function handleLogout() {
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    storage.clearToken();
    storage.clearPlayerData();
    showScene("login-scene");
    resetGameState();
}

// === Логика Лобби (Без изменений) ===
function enterLobby(playerData) {
    userGreeting.textContent = playerData.username;
    userRating.textContent = playerData.rating || 0;
    showScene("lobby-scene");
    if (socket) {
        socket.disconnect();
    }
    const token = storage.getToken();
    if (typeof io === "undefined") {
        console.error("Socket.IO library not found!");
        return;
    }
    socket = io(window.location.origin, {
        auth: { token: token },
        transports: ["websocket", "polling"],
    });
    setupSocketListeners();
}

/**
 * Сброс состояния игры (Без изменений)
 */
function resetGameState() {
    currentGameId = null;
    currentGameState = {
        board_state: [],
        dice: [],
        possible_turns: [],
        turn: 0,
        borne_off_white: 0,
        borne_off_black: 0,
        can_undo: false,
    };
    selectedCheckerPoint = null;
    isAnimating = false;
    animationStartTime = 0;
    playerSign = 1;
    clientMoveQueue = [];
    isProcessingQueue = false;

    if (boardContainer) {
        boardContainer.querySelectorAll(".point").forEach((p) => p.remove());
        diceArea.innerHTML = "";
    }
}

/**
 * Настраивает "слушателей" для сокета (В основном без изменений)
 */
function setupSocketListeners() {
    // ... (Все слушатели сокета без изменений, так как логика стековых ходов и обработки ошибок была корректной)
    if (!socket) return;

    socket.onAny((eventName, ...args) => {
        console.log(`[DEBUG] ПОЛУЧЕНО СОБЫТИЕ: << ${eventName} >>`, args);
    });

    // (Остальной код setupSocketListeners скопирован из исходного файла без изменений, т.к. он не влиял на баги интерактивности)
    socket.on("connect", () => console.log("Socket.IO: Успешно подключен!"));
    socket.on("disconnect", (reason) =>
        console.log("Socket.IO: Отключен.", reason)
    );

    socket.on("profile_data_update", (playerData) => {
        storage.savePlayerData(playerData);
        socket.emit("client_ready_for_sync");
    });

    socket.on("sync_complete_no_game", () => showScene("lobby-scene"));
    socket.on("game_created", (data) => {
        currentGameId = data.game_id;
    });

    socket.on("initial_setup", (gameData) => {
        if (gameData.white_setup === null && gameData.black_setup === null) {
            if (gameData.opponent_data) {
                updateOpponentInfo(gameData.opponent_data);
            }
            return;
        }

        const newBoardState = new Array(28).fill(0);

        if (gameData.white_setup) {
            for (const [point, count] of Object.entries(gameData.white_setup)) {
                newBoardState[parseInt(point)] = count;
            }
        }
        if (gameData.black_setup) {
            for (const [point, count] of Object.entries(gameData.black_setup)) {
                newBoardState[parseInt(point)] = -count;
            }
        }

        enterGame(gameData);

        updateGame(
            {
                board_state: newBoardState,
                turn: 0,
                dice: [],
                possible_turns: [],
                borne_off_white: 0,
                borne_off_black: 0,
                can_undo: false,
            },
            { animate: false }
        );
    });

    socket.on("full_game_sync", (gameState) => {
        const syncState = Array.isArray(gameState) ? gameState[0] : gameState;

        console.log("[DEBUG] Received full_game_sync", syncState);

        // (!!!) Сброс очередей при принудительной синхронизации
        clientMoveQueue = [];
        isProcessingQueue = false;

        if (
            gameScene.classList.contains("active") === false ||
            boardContainer.querySelectorAll(".point").length === 0
        ) {
            enterGame({});
        }
        currentGameState = {};

        updateGame(syncState, {
            animate: false,
            forceSync: true,
        });
    });

    socket.on("initial_roll_result", (data) => {
        const result = data;
        if (!result) return;

        const botSign = playerSign * -1;
        let newTurn = 0;

        if (result.first_turn === "bot") {
            gameStatus.textContent = "Первый ход Бота...";
            newTurn = botSign;
        } else if (result.first_turn === "player") {
            gameStatus.textContent = "Ваш первый ход!";
            newTurn = playerSign;
            playSound("notify");
        }

        updateGame({ turn: newTurn, can_undo: false }, { animate: false });
    });

    socket.on("dice_roll_result", (data) => {
        const newGameState = Array.isArray(data) ? data[0] : data;
        if (newGameState && newGameState.dice) {
            newGameState.can_undo = false;
            updateGame(newGameState, { animate: false, animateDice: true });
        }
    });

    socket.on("bot_dice_roll_result", (data) => {
        const diceData = Array.isArray(data) ? data[0] : data;
        if (diceData && diceData.dice) {
            // (!!!) ИЗМЕНЕНИЕ (!!!)
            // Вызываем updateGame, чтобы сохранить кости в currentGameState
            // и использовать стандартную логику анимации костей.
            const newState = {
                dice: diceData.dice,
                can_undo: false,
                turn: playerSign * -1, // Убедимся, что ход бота
            };
            // Мы анимируем кости (animateDice: true), но не ход (animate: false)
            updateGame(newState, { animate: false, animateDice: true });
        }
    });

    socket.on("move_rejection", (data) => {
        console.warn("X. Ход отклонен:", data.message);
        playSound("error");
        gameStatus.textContent = `Ошибка: ${data.message}`;
        selectedCheckerPoint = null;

        const isFatalDesync =
            data.message === "Вы уже ходили, завершите ход." ||
            data.message === "Кубики уже брошены.";

        if (isProcessingQueue || isFatalDesync) {
            console.warn(
                "Отказ во время стекового хода ИЛИ фатальный рассинхрон. Запрашиваем полный сброс."
            );
            clientMoveQueue = [];
            isProcessingQueue = false;

            if (data.message === "Вы уже ходили, завершите ход.") {
                console.warn(
                    "Предполагаем состояние 'Завершите ход' и обновляем UI..."
                );

                updateGame(
                    {
                        possible_turns: [],
                        can_undo: true,
                        turn: playerSign,
                    },
                    { animate: false }
                );

                if (socket) {
                    console.log(
                        "Отправляем: request_full_game_sync (для верификации)"
                    );
                    socket.emit("request_full_game_sync");
                }
            } else {
                if (socket) {
                    console.log("Отправляем: request_full_game_sync");
                    socket.emit("request_full_game_sync");
                }
            }
        } else {
            renderHighlights();
            isAnimating = false;
            animationStartTime = 0;
        }
    });

    socket.on("step_accepted", (data) => {
        const newGameState = Array.isArray(data) ? data[0] : data;

        if (newGameState.remaining_dice !== undefined) {
            newGameState.dice = newGameState.remaining_dice;
            delete newGameState.remaining_dice;
        }

        if (newGameState) {
            currentGameState = { ...currentGameState, ...newGameState };

            if (
                isProcessingQueue &&
                clientMoveQueue.length > 0 &&
                newGameState.applied_move
            ) {
                animateMove(
                    newGameState.applied_move,
                    newGameState.was_blot,
                    playerSign
                ).then(() => {
                    renderBoard(currentGameState.board_state);
                    renderBorneOff(
                        currentGameState.borne_off_white,
                        currentGameState.borne_off_black
                    );
                    processMoveQueue();
                });
            } else {
                isProcessingQueue = false;
                clientMoveQueue = [];
                updateGame(newGameState, { animate: true });
            }
        } else {
            isAnimating = false;
            animationStartTime = 0;
            isProcessingQueue = false;
            clientMoveQueue = [];
        }
    });

    socket.on("on_opponent_step_executed", (data) => {
        const partialState = Array.isArray(data) ? data[0] : data;
        if (partialState && partialState.board_state) {
            // (!!!) ИЗМЕНЕНИЕ (!!!)
            // Нормализуем 'remaining_dice', которые присылает сервер,
            // чтобы 'updateGame' корректно отобразил оставшиеся кости.
            if (partialState.remaining_dice !== undefined) {
                // --- ПУТЬ А: Сервер прислал 'remaining_dice' (идеально) ---
                partialState.dice = partialState.remaining_dice;
                delete partialState.remaining_dice;
            } else if (partialState.dice !== undefined) {
                // --- ПУТЬ Б: Сервер прислал 'dice' (тоже хорошо) ---
                // Ничего не делаем, 'partialState.dice' будет использован
            } else {
                // --- ПУТЬ В: (!!!) НАШ ХАК (!!!) ---
                // Сервер не прислал *никаких* данных о костях.
                // Мы знаем, что 1 ход = 1 использованный кубик.
                // Вручную удаляем один кубик из текущего состояния.

                if (currentGameState.dice && currentGameState.dice.length > 0) {
                    // 1. Копируем текущий массив костей
                    const currentDice = [...currentGameState.dice];

                    // 2. Удаляем *первый* элемент из копии
                    currentDice.shift();

                    // 3. Вставляем этот урезанный массив в данные для обновления
                    partialState.dice = currentDice;

                    console.log(
                        "[HACK] Ход бота без данных о костях. Вручную ставим кости:",
                        partialState.dice
                    );
                } else {
                    // Костей уже нет, просто защищаемся от 'undefined'
                    delete partialState.dice;
                }
            }

            partialState.is_opponent_move = true;
            updateGame(partialState, { animate: true });
        }
    });
    // (!!!) ДОБАВЬТЕ ЭТОТ ОБРАБОТЧИК (!!!)
    socket.on("undo_accepted", (data) => {
        const newGameState = Array.isArray(data) ? data[0] : data;

        if (newGameState) {
            console.log(
                "[DEBUG] 'undo_accepted' принят, обновляем состояние.",
                newGameState
            );

            // Судя по логам, сервер присылает 'remaining_dice'.
            // Нормализуем это для функции updateGame.
            if (newGameState.remaining_dice !== undefined) {
                newGameState.dice = newGameState.remaining_dice;
                delete newGameState.remaining_dice;
            }

            // Мы не хотим "анимацию" отмены, мы хотим
            // немедленно "щелкнуть" доску в правильное состояние,
            // которое прислал сервер.
            updateGame(newGameState, { animate: false, forceSync: true });
        } else {
            // На всякий случай, если придет битый ответ
            console.warn(
                "Получен 'undo_accepted' без данных, запрашиваем полный сброс."
            );
            if (socket) socket.emit("request_full_game_sync");
        }
    });

    socket.on("turn_finished", (data) => {
        const newState = {
            dice: [],
            possible_turns: [],
            can_undo: false,
        };

        if (currentGameState.turn != playerSign) {
            playSound("notify");
            newState.turn = playerSign;
            newState.board_state = currentGameState.board_state;
        } else {
            newState.turn = playerSign * -1;
        }
        updateGame(newState, { animate: false });
    });

    socket.on("auth_failed", () => handleLogout());

    socket.on("game_over", (data) => {
        handleGameOver(data.winner, data.reason);
    });

    socket.on("opponent_timeout_victory", (data) => {
        handleGameOver(playerSign, "timeout");
    });
}

// === Обработчики Игры (Без изменений) ===
function handleGameOver(winnerSign, reason) {
    // ... (Без изменений)
    isAnimating = false;
    animationStartTime = 0;
    let message = "";

    if (winnerSign == playerSign) {
        message = "Вы победили!";
    } else {
        message = "Вы проиграли.";
    }

    if (reason === "give_up") {
        message += " (Сдача)";
    } else if (reason === "timeout") {
        message = "Оппонент отключился. Вам присуждена победа!";
    }

    gameStatus.textContent = message;
    alert(`Игра окончена! ${message}`);
    handleLeaveGame(true);
}

function handleStartPVE() {
    // ... (Без изменений)
    if (socket && socket.connected) {
        if (currentGameId) {
            console.warn("Попытка начать новую игру, находясь в текущей.");
            if (!gameScene.classList.contains("active")) {
                showScene("game-scene");
            }
            return;
        }

        gameStatus.textContent = "Создание игры...";
        startPveBtn.disabled = true;
        playerSign = 1;
        socket.emit("start_pve", {
            bot_level: "easy",
            player_sign: playerSign,
        });
    }
}

async function checkAuthOnLoad() {
    // ... (Без изменений)
    const token = storage.getToken();
    if (!token) {
        showScene("login-scene");
        return;
    }
    const result = await apiRequest("/profile", "GET", null, token);
    if (result.status === "success") {
        storage.savePlayerData(result.player_data);
        enterLobby(result.player_data);
    } else {
        storage.clearToken();
        showScene("login-scene");
    }
}

// === ЛОГИКА СЦЕНЫ ИГРЫ ===

/**
 * (!!!) ИСПРАВЛЕНО: Корректное назначение панелей
 */
function updateOpponentInfo(opponentData) {
    if (opponentData && opponentData.username) {
        if (playerSign == 1) {
            // Мы Белые (1, внизу). Оппонент Черный (-1). ВЕРХНЯЯ панель (blackName).
            gameHeader.blackName.textContent = opponentData.username;
        } else {
            // Мы Черные (-1, вверху). Оппонент Белый (1). НИЖНЯЯ панель (whiteName).
            gameHeader.whiteName.textContent = opponentData.username;
        }
    }
}

/**
 * (!!!) ИСПРАВЛЕНО: Корректное назначение панелей
 */
function enterGame(gameData) {
    startPveBtn.disabled = false;

    const playerData = storage.getPlayerData();
    const myUsername = playerData ? playerData.username : "Игрок";

    // Устанавливаем свое имя
    if (playerSign == 1) {
        // Мы Белые (1). Мы в НИЖНЕЙ панели (whiteName).
        gameHeader.whiteName.textContent = myUsername;
        gameHeader.blackName.textContent = "Оппонент"; // Сброс
    } else {
        // Мы Черные (-1). Мы в ВЕРХНЕЙ панели (blackName).
        gameHeader.blackName.textContent = myUsername;
        gameHeader.whiteName.textContent = "Оппонент"; // Сброс
    }

    if (gameData && gameData.opponent_data) {
        updateOpponentInfo(gameData.opponent_data);
    }

    gameStatus.textContent = "Подключение к игре...";

    initializeBoardPoints();
    renderBorneOff(0, 0);
    showScene("game-scene");

    if (
        currentGameId &&
        gameData &&
        (gameData.white_setup || gameData.black_setup)
    ) {
        socket.emit("client_ready_for_roll", { game_id: currentGameId });
    }
}

/**
 * (!!!) ИСПРАВЛЕНО: Корректное назначение индикатора хода
 * (!!!) ИСПРАВЛЕНО: Управление кнопками через .disabled
 */
async function updateGame(
    newGameState,
    options = {
        animate: true,
        animateDice: false,
        forceSync: false,
    }
) {
    if (!newGameState) return;

    console.log("--- [DEBUG] 1. updateGame START ---", newGameState);

    isAnimating = true;
    animationStartTime = Date.now();

    try {
        // 1. Анимация хода (если есть)
        if (
            options.animate &&
            !options.forceSync &&
            newGameState.applied_move
        ) {
            const moveSign = newGameState.is_opponent_move
                ? playerSign * -1
                : playerSign;
            await animateMove(
                newGameState.applied_move,
                newGameState.was_blot,
                moveSign
            );
        }

        // 2. Обновление состояния
        currentGameState = { ...currentGameState, ...newGameState };

        const {
            dice,
            board_state,
            turn,
            possible_turns,
            borne_off_white,
            borne_off_black,
            can_undo,
        } = currentGameState;

        // 3. Обновляем статус и активного игрока
        const myTurn = turn == playerSign;
        if (!options.animateDice || options.forceSync) {
            gameStatus.textContent =
                turn == 0
                    ? "Ожидание..."
                    : myTurn
                    ? "Ваш ход"
                    : "Ход оппонента";
        }

        // (!!!) ИСПРАВЛЕНО: Логика подсветки хода
        // Верхняя панель (blackInfo) для Черных (turn === -1)
        gameHeader.blackInfo.classList.toggle("active-turn", turn == -1);
        // Нижняя панель (whiteInfo) для Белых (turn === 1)
        gameHeader.whiteInfo.classList.toggle("active-turn", turn == 1);

        // 4. (!!!) ИСПРАВЛЕНО: Управляем интерактивностью кнопок
        const hasRolled = dice && dice.length > 0;
        const hasMoves = possible_turns && possible_turns.length > 0;
        const hasStartedTurn = hasRolled || can_undo === true;
        const canRoll = myTurn && !hasStartedTurn;
        const canFinish = myTurn && hasStartedTurn && !hasMoves;
        const canUndo = myTurn && can_undo === true;

        // (!!!) ИСПРАВЛЕНО: Меняем display:none на .disabled для стабильного UI
        rollDiceBtn.disabled = !canRoll;
        finishTurnBtn.disabled = !canFinish;
        undoBtn.disabled = !canUndo;

        if (canFinish) {
            gameStatus.textContent = "Нет доступных ходов. Завершите ход.";
        }

        // 5. Рендерим кубики
        if (options.animateDice && !options.forceSync) {
            await animateDiceRoll(dice);
            gameStatus.textContent = myTurn ? "Ваш ход" : "Ход оппонента";
        }
        renderDice(dice);

        // 6. Рендерим шашки и точки
        renderBoard(board_state);

        // 7. Рендерим выведенные шашки
        renderBorneOff(borne_off_white, borne_off_black);

        // 8. Обновляем подсветку и возможность перетаскивания
        renderHighlights();
        updateDraggableState();
        console.log("--- [DEBUG] 4. updateGame FINISH ---");
    } catch (e) {
        console.error("!!!!!!!!! КРАШ ВНУТРИ updateGame: !!!!!!!!!", e);
    } finally {
        isAnimating = false;
        animationStartTime = 0;
    }
}

// === АНИМАЦИИ ===

/**
 * Анимирует движение шашки (Без изменений).
 */
async function animateMove(move, wasBlot = false, moveSign) {
    // ... (Без изменений)
    const { from, to } = move;

    const fromPointEl = document.getElementById(`point-${from}`);
    if (!fromPointEl) return;

    const checkerEl = fromPointEl.querySelector(".checker:last-of-type");

    if (!checkerEl) return;

    const startRect = checkerEl.getBoundingClientRect();
    const boardRect = boardContainer.getBoundingClientRect();
    const startX = startRect.left - boardRect.left;
    const startY = startRect.top - boardRect.top;

    const movingChecker = checkerEl.cloneNode(true);
    movingChecker.classList.add("moving");
    movingChecker.removeAttribute("draggable");
    movingChecker.style.width = `${startRect.width}px`;
    movingChecker.style.left = `${startX}px`;
    movingChecker.style.top = `${startY}px`;
    movingChecker.style.transitionDuration = `${ANIMATION_DURATION}ms`;

    boardContainer.appendChild(movingChecker);

    checkerEl.style.visibility = "hidden";

    const targetCoords = getTargetCoordinates(to, moveSign);

    playSound(wasBlot ? "hit" : "move");

    return new Promise((resolve) => {
        requestAnimationFrame(() => {
            movingChecker.style.left = `${targetCoords.x}px`;
            movingChecker.style.top = `${targetCoords.y}px`;
        });

        setTimeout(resolve, ANIMATION_DURATION);
    });
}

/**
 * (!!!) ИСПРАВЛЕНО: Корректное определение лотков вывода
 */
function getTargetCoordinates(pointIndex, moveSign) {
    const boardRect = boardContainer.getBoundingClientRect();

    // 1. Обработка вывода шашек (Bearing off)
    let targetTray = null;
    const signToUse = moveSign !== undefined ? moveSign : currentGameState.turn;

    // (!!!) ИСПРАВЛЕНО: Назначение лотков согласно HTML и ориентации
    if (signToUse == 1 && isWhiteBearingOffPoint(pointIndex)) {
        // Белые (1) выводят в НИЖНИЙ лоток (white)
        targetTray = document.getElementById("borne-tray-white");
    } else if (signToUse == -1 && isBlackBearingOffPoint(pointIndex)) {
        // Черные (-1) выводят в ВЕРХНИЙ лоток (black)
        targetTray = document.getElementById("borne-tray-black");
    }

    if (targetTray) {
        const trayRect = targetTray.getBoundingClientRect();
        return {
            x: trayRect.left - boardRect.left,
            y: trayRect.top - boardRect.top + trayRect.height / 2,
        };
    }

    // 2. Обработка хода на доску (Остальная логика без изменений)
    const pointEl = document.getElementById(`point-${pointIndex}`);
    if (!pointEl) return { x: 0, y: 0 };

    const pointRect = pointEl.getBoundingClientRect();
    const existingCheckers = pointEl.querySelectorAll(".checker").length;

    // 3. Расчет высоты шашки
    let checkerHeight = pointRect.width;
    if (existingCheckers > 0) {
        const sampleChecker = pointEl.querySelector(".checker");
        if (sampleChecker) {
            checkerHeight = sampleChecker.getBoundingClientRect().height;
        }
    }

    // 4. Расчет смещения (Offset) с учетом "плавного" сжатия
    const count = existingCheckers + 1; // Будущее кол-во шашек
    let marginPercent = 0;

    if (count <= COMPRESS_AFTER_N_CHECKERS) {
        marginPercent = BASE_GAP_PERCENT;
    } else {
        const checkersOver = count - COMPRESS_AFTER_N_CHECKERS;
        const compressionFactor = Math.min(
            checkersOver / CHECKERS_TO_MAX_COMPRESSION,
            1.0
        );
        // Плавный переход от BASE_GAP_PERCENT до MAX_OVERLAP_PERCENT
        marginPercent =
            BASE_GAP_PERCENT +
            compressionFactor * (MAX_OVERLAP_PERCENT - BASE_GAP_PERCENT);
    }

    const gapInPixels = (marginPercent / 100) * checkerHeight;
    const offset = existingCheckers * (checkerHeight + gapInPixels);

    // 5. Расчет координат X и Y
    let targetX = pointRect.left - boardRect.left;
    let targetY;

    const isColumnReverse =
        window.getComputedStyle(pointEl).flexDirection === "column-reverse";

    if (!isColumnReverse) {
        targetY = pointRect.top - boardRect.top + offset;
    } else {
        targetY = pointRect.bottom - boardRect.top - offset - checkerHeight;
    }

    return { x: targetX, y: targetY };
}

/**
 * Анимирует бросок костей (Без изменений).
 */
async function animateDiceRoll(diceValues) {
    // ... (Без изменений)
    return new Promise((resolve) => {
        diceArea.innerHTML = "";
        playSound("roll");

        const diceElements = diceValues.map(() => {
            const die = document.createElement("div");
            die.className = "die rolling";
            die.textContent = Math.floor(Math.random() * 6) + 1;
            diceArea.appendChild(die);
            return die;
        });

        setTimeout(() => {
            diceElements.forEach((die, index) => {
                die.classList.remove("rolling");
                die.textContent = diceValues[index];
            });
            resolve();
        }, DICE_ROLL_DURATION);
    });
}

// === РЕНДЕРИНГ ===

/**
 * (!!!) ИСПРАВЛЕНО: Убрана запутанная логика "переворота" ID.
 * Теперь ID пунктов соответствуют стандартной нотации (1-24).
 * Визуализация управляется исключительно через CSS.
 */
function initializeBoardPoints() {
    // Очистка
    boardContainer.querySelectorAll(".point").forEach((p) => p.remove());
    boardContainer
        .querySelectorAll(".checker.moving")
        .forEach((c) => c.remove());

    for (let i = 0; i <= 25; i++) {
        // Используем прямой индекс.
        const pointIndex = i;

        const pointDiv = document.createElement("div");
        pointDiv.className = "point";

        pointDiv.id = `point-${pointIndex}`;
        pointDiv.setAttribute("data-point", pointIndex);

        // Обработчик клика (для Click-to-Move)
        pointDiv.onclick = () => onPointClick(pointIndex);

        // Обработчики Drag and Drop для ТОЧКИ
        pointDiv.addEventListener("dragover", (e) =>
            handleDragOver(e, pointIndex)
        );
        pointDiv.addEventListener("dragenter", (e) =>
            handleDragEnter(e, pointIndex)
        );
        pointDiv.addEventListener("dragleave", (e) =>
            handleDragLeave(e, pointIndex)
        );
        pointDiv.addEventListener("drop", (e) => handleDrop(e, pointIndex));

        // Добавляем слой подсветки
        const highlightDiv = document.createElement("div");
        highlightDiv.className = "highlight";
        pointDiv.appendChild(highlightDiv);

        boardContainer.appendChild(pointDiv);
    }
}

/**
 * Рендеринг доски (Плавное сжатие, DOM-diffing)
 */
function renderBoard(boardState) {
    // ... (В основном без изменений, кроме обновленной логики плавного сжатия)
    console.log("--- [DEBUG] renderBoard START (Diffing & Animating) ---");

    boardContainer
        .querySelectorAll(".checker.moving")
        .forEach((c) => c.remove());

    if (!boardState || boardState.length === 0) return;

    for (let pointIndex = 0; pointIndex <= 25; pointIndex++) {
        const pointEl = document.getElementById(`point-${pointIndex}`);
        if (!pointEl) continue;

        const numCheckers = boardState[pointIndex] || 0;
        const count = Math.abs(numCheckers);
        const isWhite = numCheckers > 0;
        const newSrc = isWhite
            ? "assets/whiteChecker0.png"
            : "assets/blackChecker0.png";

        const existingCheckers = pointEl.querySelectorAll(".checker");

        // Логика сжатия (Обновлена для плавного перехода)
        let marginPercent = 0;
        if (count <= COMPRESS_AFTER_N_CHECKERS) {
            marginPercent = BASE_GAP_PERCENT;
        } else {
            const checkersOver = count - COMPRESS_AFTER_N_CHECKERS;
            const compressionFactor = Math.min(
                checkersOver / CHECKERS_TO_MAX_COMPRESSION,
                1.0
            );
            // Плавный переход от BASE_GAP_PERCENT до MAX_OVERLAP_PERCENT
            marginPercent =
                BASE_GAP_PERCENT +
                compressionFactor * (MAX_OVERLAP_PERCENT - BASE_GAP_PERCENT);
        }

        const isColumnReverse =
            window.getComputedStyle(pointEl).flexDirection === "column-reverse";
        const marginSide = isColumnReverse ? "marginTop" : "marginBottom";

        let lastUpdatedChecker = null;

        // Добавление/Обновление шашек
        for (let i = 0; i < count; i++) {
            let checker = existingCheckers[i];

            if (!checker) {
                checker = document.createElement("img");
                checker.className = "checker";
                checker.src = newSrc;
                pointEl.appendChild(checker);
            }

            if (checker.src.endsWith(newSrc) === false) {
                checker.src = newSrc;
            }

            if (i > 0) {
                checker.style[marginSide] = `${marginPercent}%`;
            } else {
                checker.style[marginSide] = "0px";
            }

            checker.setAttribute("draggable", "false");

            const oldIndicator = checker.querySelector(
                ".checker-count-indicator"
            );
            if (oldIndicator) {
                oldIndicator.remove();
            }

            lastUpdatedChecker = checker;
        }

        // Удаление лишних шашек
        if (existingCheckers.length > count) {
            for (let i = count; i < existingCheckers.length; i++) {
                existingCheckers[i].remove();
            }
        }

        // Добавление индикатора количества
        if (lastUpdatedChecker && count > COMPRESS_AFTER_N_CHECKERS) {
            const countIndicator = document.createElement("span");
            countIndicator.className = "checker-count-indicator";
            countIndicator.textContent = count;
            lastUpdatedChecker.appendChild(countIndicator);
        }
    }
    console.log("--- [DEBUG] renderBoard FINISH ---");
}

/**
 * (!!!) ИСПРАВЛЕНО: Корректное назначение лотков вывода
 */
function renderBorneOff(whiteCount, blackCount) {
    // Согласно HTML, whiteTray - Нижний, blackTray - Верхний
    const whiteTray = document.getElementById("borne-tray-white");
    const blackTray = document.getElementById("borne-tray-black");

    whiteTray.innerHTML = "";
    blackTray.innerHTML = "";

    // Белые шашки в нижний лоток (whiteTray)
    for (let i = 0; i < whiteCount; i++) {
        const checker = document.createElement("div");
        checker.className = "checker-borne white";
        whiteTray.appendChild(checker);
    }

    // Черные шашки в верхний лоток (blackTray)
    for (let i = 0; i < blackCount; i++) {
        const checker = document.createElement("div");
        checker.className = "checker-borne black";
        blackTray.appendChild(checker);
    }
}

function renderDice(dice) {
    // ... (Без изменений)
    if (diceArea.querySelector(".rolling")) return;

    diceArea.innerHTML = "";
    if (!dice || dice.length === 0) return;

    dice.forEach((value) => {
        const die = document.createElement("div");
        die.className = "die";
        die.textContent = value;
        diceArea.appendChild(die);
    });
}

/**
 * Очищает подсветку (Без изменений)
 */
function clearHighlights() {
    document.querySelectorAll(".point").forEach((p) => {
        p.classList.remove("highlight-active-destination", "drag-over");
    });

    document.querySelectorAll(".checker").forEach((c) => {
        c.classList.remove("highlight-active-source", "highlight-selected");
    });

    document.querySelectorAll(".borne-tray").forEach((t) => {
        t.classList.remove("highlight-active-destination", "drag-over");
    });
}

/**
 * Устанавливает draggable
 */
function updateDraggableState() {
    document.querySelectorAll(".checker").forEach((c) => {
        c.setAttribute("draggable", "false");
    });

    const possibleTurns = currentGameState.possible_turns || [];
    const myTurn = currentGameState.turn == playerSign;

    if (!myTurn || possibleTurns.length === 0) {
        return;
    }

    const movableCheckers = new Set();
    possibleTurns.forEach((turnArray) => {
        if (turnArray.length > 0) {
            // Используем parseInt для надежности
            movableCheckers.add(parseInt(turnArray[0].from));
        }
    });

    movableCheckers.forEach((pointIndex) => {
        const pointEl = document.getElementById(`point-${pointIndex}`);
        if (pointEl) {
            const topChecker = pointEl.querySelector(".checker:last-of-type");
            if (topChecker) {
                topChecker.setAttribute("draggable", "true");
            }
        }
    });
}

/**
 * (!!!) ИСПРАВЛЕНО: Логика подсветки ходов.
 * Теперь ищет "чистые префиксы" - все пункты, куда может дойти выбранная шашка,
 * двигаясь последовательно, даже если остаток хода выполняется другой шашкой.
 */
function renderHighlights() {
    clearHighlights();

    const possibleTurns = currentGameState.possible_turns || [];
    const myTurn = currentGameState.turn == playerSign;

    if (!myTurn || possibleTurns.length === 0) {
        return;
    }

    if (selectedCheckerPoint === null) {
        // --- РЕЖИМ 1: Ничего не выбрано ---
        const movableCheckers = new Set();
        possibleTurns.forEach((turnArray) => {
            if (turnArray.length > 0) {
                // Используем parseInt для надежности
                movableCheckers.add(parseInt(turnArray[0].from));
            }
        });

        movableCheckers.forEach((pointIndex) => {
            const pointEl = document.getElementById(`point-${pointIndex}`);
            if (pointEl) {
                const topChecker = pointEl.querySelector(
                    ".checker:last-of-type"
                );
                if (topChecker) {
                    topChecker.classList.add("highlight-active-source");
                }
            }
        });
    } else {
        // --- РЕЖИМ 2: Шашка выбрана ---
        // 2a. Подсвечиваем ВЫБРАННУЮ шашку
        const fromPointEl = document.getElementById(
            `point-${selectedCheckerPoint}`
        );
        if (fromPointEl && !fromPointEl.querySelector(".dragging")) {
            const topChecker = fromPointEl.querySelector(
                ".checker:last-of-type"
            );
            if (topChecker) {
                topChecker.classList.add("highlight-selected");
            }
        }

        // 2b. (!!!) ИСПРАВЛЕНО: Ищем все ДОСТИЖИМЫЕ точки для ЭТОЙ шашки (Чистые префиксы).
        const destinations = new Set();
        const fromPoint = parseInt(selectedCheckerPoint);

        possibleTurns.forEach((turnArray) => {
            // Мы интересуемся только ходами, начинающимися с выбранной точки
            if (
                turnArray.length > 0 &&
                parseInt(turnArray[0].from) === fromPoint
            ) {
                let currentPos = fromPoint;

                // Итерируемся по ходу, пока двигается та же самая шашка (строгая последовательность)
                for (const step of turnArray) {
                    const stepFrom = parseInt(step.from);
                    const stepTo = parseInt(step.to);

                    if (stepFrom === currentPos) {
                        // Эта шашка может сюда походить. Подсвечиваем.
                        destinations.add(stepTo);
                        currentPos = stepTo;
                    } else {
                        // Начала двигаться другая шашка (или произошел недопустимый прыжок).
                        // Прекращаем анализ этого хода.
                        break;
                    }
                }
            }
        });

        // 2c. Подсвечиваем найденные цели
        destinations.forEach((toPoint) => {
            if (isBearingOffPoint(toPoint, playerSign)) {
                let targetTray;
                // (!!!) ИСПРАВЛЕНО: Корректные лотки
                if (playerSign == 1) {
                    // Белые (1) -> Нижний лоток (white)
                    targetTray = document.getElementById("borne-tray-white");
                } else {
                    // Черные (-1) -> Верхний лоток (black)
                    targetTray = document.getElementById("borne-tray-black");
                }
                if (targetTray) {
                    targetTray.classList.add("highlight-active-destination");
                }
                return;
            }

            const toPointEl = document.getElementById(`point-${toPoint}`);
            if (toPointEl) {
                toPointEl.classList.add("highlight-active-destination");
            }
        });
    }
}

/**
 * (!!!) ИСПРАВЛЕНО: Поиск последовательности хода (Чистый префикс).
 * Гарантирует, что будет найдена последовательность шагов из fromPoint в toPoint,
 * используя ТОЛЬКО выбранную шашку (строгая последовательность).
 */
function findTurnSequence(fromPoint, toPoint) {
    const possibleTurns = currentGameState.possible_turns || [];
    const validPrefixes = [];

    // Приводим к числу для надежного сравнения
    fromPoint = parseInt(fromPoint);
    toPoint = parseInt(toPoint);

    for (const turnArray of possibleTurns) {
        if (
            turnArray.length === 0 ||
            parseInt(turnArray[0].from) !== fromPoint
        ) {
            continue;
        }

        const prefix = [];
        let currentPos = fromPoint;
        let foundTarget = false;
        let isPrefixPure = true;

        for (const step of turnArray) {
            const stepFrom = parseInt(step.from);
            const stepTo = parseInt(step.to);

            if (stepFrom !== currentPos) {
                // Этот шаг нарушает строгую последовательность.
                // Это означает, что начала двигаться другая шашка.
                isPrefixPure = false;
                break;
            }

            prefix.push(step);
            currentPos = stepTo;

            if (stepTo === toPoint) {
                foundTarget = true;
                break; // Мы дошли до цели
            }
        }

        // Учитываем только если мы дошли до цели И путь был "чистым".
        if (foundTarget && isPrefixPure) {
            // Добавляем найденную под-последовательность (префикс)
            validPrefixes.push([...prefix]);
        }
    }

    // Выбираем самый короткий префикс (используем меньше всего кубиков)
    if (validPrefixes.length > 0) {
        validPrefixes.sort((a, b) => a.length - b.length);
        console.log("Найден валидный префикс хода:", validPrefixes[0]);
        return validPrefixes[0];
    }

    console.warn(
        "НЕ НАЙДЕНО валидного префикса для:",
        fromPoint,
        "->",
        toPoint
    );
    return null;
}

/**
 * Обрабатывает нашу очередь "стековых" ходов (Без изменений)
 */
function processMoveQueue() {
    if (clientMoveQueue.length === 0) {
        isProcessingQueue = false;
        return;
    }

    // Берем следующий шаг из очереди
    const step = clientMoveQueue.shift();

    console.log("ОТПРАВКА 'СТЕКОВОГО' ХОДА (Шаг):", step);
    // Отправляем как есть, сервер должен справиться с типами, но для надежности можно и parseInt
    socket.emit("send_player_step", { step: step });
}

/**
 * Логика Drag and Drop (В основном без изменений)
 */

function checkAnimationFailsafe() {
    if (isAnimating) {
        const animationDuration = Date.now() - animationStartTime;
        if (animationStartTime > 0 && animationDuration > 3000) {
            // 3 секунды
            console.warn(
                `[FAILSAFE] UI 'stuck' for ${animationDuration}ms. Forcing sync.`
            );
            isAnimating = false;
            animationStartTime = 0;
            if (socket) socket.emit("request_full_game_sync");

            // (!!!) ИСПРАВЛЕНО:
            // Мы "починили" зависание, поэтому должны
            // вернуть 'false', чтобы позволить
            // текущему клику (например, "Сдаться") выполниться.
            return false;
        }
        return true; // "Да, мы анимируемся, блокируй"
    }
    return false; // "Нет, мы не анимируемся, продолжай"
}

function handleDragOver(e, pointIndex) {
    if (selectedCheckerPoint === null) return;
    const pointEl = document.getElementById(`point-${pointIndex}`);
    if (pointEl && pointEl.classList.contains("highlight-active-destination")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
    }
}

function handleDragEnter(e, pointIndex) {
    const pointEl = document.getElementById(`point-${pointIndex}`);
    if (pointEl && pointEl.classList.contains("highlight-active-destination")) {
        pointEl.classList.add("drag-over");
    }
}

function handleDragLeave(e, pointIndex) {
    const pointEl = document.getElementById(`point-${pointIndex}`);
    if (pointEl) {
        pointEl.classList.remove("drag-over");
    }
}

function handleDrop(e, pointIndex) {
    e.preventDefault();
    if (selectedCheckerPoint === null) return;
    executeMove(selectedCheckerPoint, pointIndex);
    selectedCheckerPoint = null;
}

function handleDragEnd(e) {
    e.target.classList.remove("dragging");
    document
        .querySelectorAll(".drag-over")
        .forEach((el) => el.classList.remove("drag-over"));
    if (selectedCheckerPoint !== null) {
        selectedCheckerPoint = null;
    }
    renderHighlights();
}

/**
 * ХЕЛПЕРЫ D&D для Лотков (Bearing Off)
 */
function handleTrayDragOver(e, traySign) {
    if (selectedCheckerPoint === null) return;
    // Разрешаем дроп, только если это *наш* лоток
    if (traySign == playerSign) {
        const trayEl = e.currentTarget;
        if (trayEl.classList.contains("highlight-active-destination")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
        }
    }
}

function handleTrayDragEnter(e, traySign) {
    if (traySign == playerSign) {
        const trayEl = e.currentTarget;
        if (trayEl.classList.contains("highlight-active-destination")) {
            trayEl.classList.add("drag-over");
        }
    }
}

function handleTrayDragLeave(e, traySign) {
    if (traySign == playerSign) {
        e.currentTarget.classList.remove("drag-over");
    }
}

/**
 * (!!!) ИСПРАВЛЕНО: Обработка дропа на лоток с использованием логики префиксов.
 */
function handleTrayDrop(e, traySign) {
    e.preventDefault();
    if (selectedCheckerPoint === null || traySign != playerSign) return;

    // Находим цель для вывода, используя ту же логику, что и в renderHighlights.
    const possibleTurns = currentGameState.possible_turns || [];
    let bearingOffTarget = null;
    const fromPoint = parseInt(selectedCheckerPoint);

    const destinations = new Set();

    possibleTurns.forEach((turnArray) => {
        if (turnArray.length > 0 && parseInt(turnArray[0].from) === fromPoint) {
            let currentPos = fromPoint;
            for (const step of turnArray) {
                const stepFrom = parseInt(step.from);
                const stepTo = parseInt(step.to);

                if (stepFrom === currentPos) {
                    destinations.add(stepTo);
                    currentPos = stepTo;
                } else {
                    break;
                }
            }
        }
    });

    // Проверяем, есть ли среди достижимых точек вывод
    for (const toPoint of destinations) {
        if (isBearingOffPoint(toPoint, playerSign)) {
            bearingOffTarget = toPoint;
            break;
        }
    }

    if (bearingOffTarget !== null) {
        // Выполняем ход в найденную точку вывода (findTurnSequence найдет правильный префикс)
        executeMove(selectedCheckerPoint, bearingOffTarget);
    }

    selectedCheckerPoint = null;
}

/**
 * Выполняет логику отправки хода на сервер (Без изменений).
 */
function executeMove(fromPoint, toPoint) {
    // 1. Ищем *правильный префикс* последовательности
    const sequence = findTurnSequence(fromPoint, toPoint);

    if (sequence) {
        console.log("ОТПРАВКА 'СТЕКОВОГО' ХОДА (Префикс):", sequence);

        // 2. Заполняем очередь
        clientMoveQueue = [...sequence]; // Копируем последовательность
        isProcessingQueue = true;
        isAnimating = true;
        animationStartTime = Date.now();

        // 3. Сбрасываем UI
        selectedCheckerPoint = null;
        clearHighlights();
        gameStatus.textContent = "Ход отправлен...";

        // 4. Запускаем конвейер
        processMoveQueue();
        return true;
    }

    // Если мы кликнули не туда, ничего не делаем
    console.log("Ход не найден или неверный:", fromPoint, toPoint);
    return false;
}

/**
 * (!!!) ИСПРАВЛЕНО: Проверка типов данных (используем parseInt).
 */
function onPointClick(pointIndex) {
    console.log(`Клик на точку: ${pointIndex}`);

    if (checkAnimationFailsafe()) {
        console.warn("Клик заблокирован, идет анимация.");
        return;
    }

    if (!currentGameState || currentGameState.turn != playerSign) {
        return;
    }

    const possibleTurns = currentGameState.possible_turns || [];

    // Глобальный авто-бросок костей
    if (
        currentGameState.dice.length === 0 &&
        currentGameState.can_undo === false
    ) {
        console.log("Авто-бросок костей по клику в любом месте...");
        requestDiceRoll();
        return;
    }

    if (selectedCheckerPoint === null) {
        // 1. ПЕРВЫЙ КЛИК (ВЫБОР "ОТКУДА")

        // (!!!) ИСПРАВЛЕНО: Используем parseInt для надежного сравнения
        const hasMovesFrom = possibleTurns.some(
            (turnArray) =>
                turnArray.length > 0 &&
                parseInt(turnArray[0].from) === parseInt(pointIndex)
        );

        if (hasMovesFrom) {
            selectedCheckerPoint = pointIndex;
            renderHighlights();
        }
    } else {
        // 2. ВТОРОЙ КЛИК (ВЫБОР "КУДА" или ОТМЕНА)
        if (selectedCheckerPoint == pointIndex) {
            selectedCheckerPoint = null;
            renderHighlights();
            return;
        }

        const moveExecuted = executeMove(selectedCheckerPoint, pointIndex);

        if (!moveExecuted) {
            // Ход не выполнен. Проверяем пере-выбор.

            // (!!!) ИСПРАВЛЕНО: Используем parseInt для надежного сравнения
            const hasMovesFromNew = possibleTurns.some(
                (turnArray) =>
                    turnArray.length > 0 &&
                    parseInt(turnArray[0].from) === parseInt(pointIndex)
            );

            if (hasMovesFromNew) {
                selectedCheckerPoint = pointIndex;
                renderHighlights();
            } else {
                selectedCheckerPoint = null;
                renderHighlights();
            }
        }
    }
}

/**
 * (!!!) ИСПРАВЛЕНО: Клик на лоток (использует логику handleTrayDrop).
 */
function onTrayClick(traySign) {
    if (checkAnimationFailsafe()) {
        console.warn("Клик заблокирован, идет анимация.");
        return;
    }

    if (!currentGameState || currentGameState.turn != playerSign) {
        return;
    }

    // Клик на лоток имеет смысл, только если шашка уже выбрана
    if (selectedCheckerPoint !== null && traySign == playerSign) {
        // (!!!) ИСПРАВЛЕНО: Используем ту же логику поиска цели, что и в handleTrayDrop/renderHighlights
        const possibleTurns = currentGameState.possible_turns || [];
        let bearingOffTarget = null;
        const fromPoint = parseInt(selectedCheckerPoint);

        const destinations = new Set();

        possibleTurns.forEach((turnArray) => {
            if (
                turnArray.length > 0 &&
                parseInt(turnArray[0].from) === fromPoint
            ) {
                let currentPos = fromPoint;
                for (const step of turnArray) {
                    const stepFrom = parseInt(step.from);
                    const stepTo = parseInt(step.to);

                    if (stepFrom === currentPos) {
                        destinations.add(stepTo);
                        currentPos = stepTo;
                    } else {
                        break;
                    }
                }
            }
        });

        // Проверяем, есть ли среди достижимых точек вывод
        for (const toPoint of destinations) {
            if (isBearingOffPoint(toPoint, playerSign)) {
                bearingOffTarget = toPoint;
                break;
            }
        }

        if (bearingOffTarget !== null) {
            // Выполняем ход в найденную точку вывода
            executeMove(selectedCheckerPoint, bearingOffTarget);
        } else {
            // Если кликнули, но ход невозможен, сбрасываем выбор
            selectedCheckerPoint = null;
            renderHighlights();
        }
    }
}

function handleLeaveGame(force = false) {
    // (!!!) Ваше решение убрать checkAnimationFailsafe() отсюда
    // абсолютно верное. Кнопка "Сдаться" должна работать всегда.

    if (force) {
        // --- СЛУЧАЙ 1: ИГРА УЖЕ ЗАВЕРШЕНА (вызов из handleGameOver) ---
        // Мы уже получили 'game_over' от сервера.
        // Просто выходим в лобби и всё сбрасываем.
        console.log(
            "[handleLeaveGame] force=true. Игра завершена. Выход в лобби."
        );
        showScene("lobby-scene");
        resetGameState();
        return;
    }

    // --- СЛУЧАЙ 2: ИГРОК НАЖАЛ "СДАТЬСЯ" (force = false) ---
    // Мы должны отправить запрос на сдачу, если мы в игре.
    if (socket && socket.connected && currentGameId) {
        if (
            !confirm(
                "Вы уверены, что хотите сдаться? Это приведет к поражению."
            )
        ) {
            return; // Пользователь нажал "Отмена"
        }

        // Отправляем запрос
        console.log("Отправляем: player_give_up");
        socket.emit("player_give_up");

        // Блокируем UI. Мы НЕ выходим в лобби.
        // Мы ждем, пока сервер пришлет 'game_over', который
        // затем вызовет handleGameOver -> handleLeaveGame(true).
        isAnimating = true;
        animationStartTime = Date.now();
        gameStatus.textContent = "Сдача...";
    } else {
        // --- СЛУЧАЙ 3: (Fallback) Нажата "Сдаться", но мы не в игре ---
        // Что-то пошло не так (нет socket'а или gameId),
        // просто возвращаемся в лобби.
        console.log(
            "[handleLeaveGame] force=false, но нет игры. Просто выход в лобби."
        );
        showScene("lobby-scene");
        resetGameState();
    }
}

// === Старт ===
// Добавляем обработчики
document.getElementById("login-form").addEventListener("submit", handleLogin);
registerBtn.addEventListener("click", handleRegister);

// (!!!) ИСПРАВЛЕНО: Корректное назначение обработчиков лотков
// Согласно HTML: whiteTray (Низ) для Белых (1), blackTray (Верх) для Черных (-1)
const whiteTrayEl = document.getElementById("borne-tray-white");
const blackTrayEl = document.getElementById("borne-tray-black");

// --- Клик (Click-to-Move) ---
whiteTrayEl.addEventListener("click", () => onTrayClick(1));
blackTrayEl.addEventListener("click", () => onTrayClick(-1));

// --- D&D (Drag & Drop) ---
whiteTrayEl.addEventListener("dragover", (e) => handleTrayDragOver(e, 1));
whiteTrayEl.addEventListener("dragenter", (e) => handleTrayDragEnter(e, 1));
whiteTrayEl.addEventListener("dragleave", (e) => handleTrayDragLeave(e, 1));
whiteTrayEl.addEventListener("drop", (e) => handleTrayDrop(e, 1));

blackTrayEl.addEventListener("dragover", (e) => handleTrayDragOver(e, -1));
blackTrayEl.addEventListener("dragenter", (e) => handleTrayDragEnter(e, -1));
blackTrayEl.addEventListener("dragleave", (e) => handleTrayDragLeave(e, -1));
blackTrayEl.addEventListener("drop", (e) => handleTrayDrop(e, -1));

logoutBtn.addEventListener("click", handleLogout);
leaveGameBtn.addEventListener("click", () => handleLeaveGame(false));
startPveBtn.addEventListener("click", handleStartPVE);

/**
 * Отправляет запрос на бросок костей (для кнопки и авто-броска)
 * (!!!) ИСПРАВЛЕНО: Использует .disabled
 */
function requestDiceRoll() {
    if (checkAnimationFailsafe()) {
        console.warn("Клик заблокирован, идет анимация.");
        return false;
    }

    if (socket && socket.connected) {
        console.log("Отправляем: request_player_roll");
        isAnimating = true;
        animationStartTime = Date.now();
        socket.emit("request_player_roll");

        if (rollDiceBtn) {
            // (!!!) ИСПРАВЛЕНО: Защита от двойного клика
            rollDiceBtn.disabled = true;
        }

        gameStatus.textContent = "Бросаем кости...";
        return true;
    }
    return false;
}

// Обновляем обработчик кнопки
rollDiceBtn.addEventListener("click", requestDiceRoll);

// (!!!) ИСПРАВЛЕНО: Использует .disabled
finishTurnBtn.addEventListener("click", () => {
    if (checkAnimationFailsafe()) {
        console.warn("Клик заблокирован, идет анимация.");
        return;
    }

    if (socket && socket.connected) {
        console.log("Отправляем: send_turn_finished");
        isAnimating = true;
        animationStartTime = Date.now();
        // (!!!) ИСПРАВЛЕНО: Защита от двойного клика
        finishTurnBtn.disabled = true;
        socket.emit("send_turn_finished");
        gameStatus.textContent = "Завершение хода...";
    }
});

// (!!!) ИСПРАВЛЕНО: Использует .disabled
undoBtn.addEventListener("click", () => {
    if (checkAnimationFailsafe()) {
        console.warn("Клик 'Undo' заблокирован, идет анимация.");
        return;
    }

    if (socket && socket.connected) {
        console.log("Отправляем: request_undo");
        // Не нужно ставить isAnimating = true, так как сервер
        // немедленно вернет новое состояние.
        socket.emit("request_undo");
        gameStatus.textContent = "Отмена хода...";

        // (!!!) ИСПРАВЛЕНО: Сразу отключаем кнопку, чтобы избежать двойного клика
        undoBtn.disabled = true;
    }
});

// Глобальные обработчики Drag & Drop (Делегирование событий) (Без изменений)
boardContainer.addEventListener("dragstart", (e) => {
    if (e.target.classList.contains("checker")) {
        const pointEl = e.target.closest(".point");
        if (pointEl) {
            const pointIndex = parseInt(pointEl.dataset.point, 10);
            handleDragStart(e, pointIndex);
        }
    }
});

boardContainer.addEventListener("dragend", (e) => {
    if (e.target.classList.contains("checker")) {
        handleDragEnd(e);
    }
});

checkAuthOnLoad();
