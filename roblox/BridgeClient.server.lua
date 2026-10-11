--[[
  TikTok -> Roblox Bridge Client
  Taruh sebagai *Script* (bukan LocalScript) di ServerScriptService.

  Wajib: Game Settings > Security > "Allow HTTP Requests" = ON
  BASE_URL harus URL publik (https) -- Roblox tidak bisa akses localhost.
  Pakai cloudflared / ngrok / VPS.

  Opsional: buat Part bernama "SpawnArea" di Workspace. Avatar & efek muncul di area itu.
  Opsional: dengarkan RemoteEvent ReplicatedStorage.TikTokEvent di client untuk UI sendiri.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")
local TweenService = game:GetService("TweenService")
local Debris = game:GetService("Debris")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local CONFIG = {
	BASE_URL = "__BASE_URL__",
	API_KEY = "__ROBLOX_API_KEY__",
	POLL_INTERVAL = 1.5,        -- detik antar polling
	BATCH = 5,                  -- maksimal job per polling
	MAX_AVATARS = 15,           -- jumlah avatar penonton maksimal di map
	AVATAR_LIFETIME = 120,      -- detik sebelum avatar hilang
	RIG_TYPE = Enum.HumanoidRigType.R15,
	DEFAULT_CENTER = Vector3.new(0, 5, 0),
	DEFAULT_RADIUS = 30,
}

local WORKER_ID = game.JobId ~= "" and game.JobId or ("studio-" .. tostring(math.random(1000, 9999)))

local remote = ReplicatedStorage:FindFirstChild("TikTokEvent")
if not remote then
	remote = Instance.new("RemoteEvent")
	remote.Name = "TikTokEvent"
	remote.Parent = ReplicatedStorage
end

---------------------------------------------------------------- util
local function area()
	local part = Workspace:FindFirstChild("SpawnArea")
	if part and part:IsA("BasePart") then
		return part.Position, math.max(part.Size.X, part.Size.Z) / 2
	end
	return CONFIG.DEFAULT_CENTER, CONFIG.DEFAULT_RADIUS
end

local function randomPoint(yOffset)
	local center, radius = area()
	local angle = math.random() * math.pi * 2
	local dist = math.sqrt(math.random()) * radius
	return center + Vector3.new(math.cos(angle) * dist, yOffset or 0, math.sin(angle) * dist)
end

local function api(path, body)
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = CONFIG.BASE_URL .. path,
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json",
				["x-roblox-api-key"] = CONFIG.API_KEY,
			},
			Body = HttpService:JSONEncode(body),
		})
	end)
	if not ok then
		warn("[TikTokBridge] request gagal:", res)
		return nil
	end
	if not res.Success then
		warn("[TikTokBridge] HTTP", res.StatusCode, res.Body)
		return nil
	end
	local decoded
	local okJson = pcall(function() decoded = HttpService:JSONDecode(res.Body) end)
	return okJson and decoded or nil
end

---------------------------------------------------------------- avatar
local avatars = {} -- urut kronologis { {name=, model=} }

local function removeAvatar(entry)
	if entry.model and entry.model.Parent then entry.model:Destroy() end
	for i, e in ipairs(avatars) do
		if e == entry then table.remove(avatars, i) break end
	end
end

local function spawnAvatar(payload)
	local name = payload.robloxUsername
	local okId, userId = pcall(function() return Players:GetUserIdFromNameAsync(name) end)
	if not okId or not userId then return false, "Username Roblox tidak ditemukan: " .. tostring(name) end

	local okDesc, desc = pcall(function() return Players:GetHumanoidDescriptionFromUserId(userId) end)
	if not okDesc or not desc then return false, "Gagal mengambil avatar " .. name end

	local okModel, model = pcall(function() return Players:CreateHumanoidModelFromDescription(desc, CONFIG.RIG_TYPE) end)
	if not okModel or not model then return false, "Gagal membuat model avatar" end

	-- batasi jumlah avatar
	while #avatars >= CONFIG.MAX_AVATARS do removeAvatar(avatars[1]) end
	-- satu avatar per username
	for _, e in ipairs(avatars) do
		if e.name:lower() == name:lower() then removeAvatar(e) break end
	end

	model.Name = name
	local hum = model:FindFirstChildOfClass("Humanoid")
	if hum then
		hum.DisplayName = "@" .. name
		hum.DisplayDistanceType = Enum.HumanoidDisplayDistanceType.Viewer
	end
	model:PivotTo(CFrame.new(randomPoint(4)))
	model.Parent = Workspace

	local entry = { name = name, model = model }
	table.insert(avatars, entry)
	Debris:AddItem(model, CONFIG.AVATAR_LIFETIME)

	-- jalan-jalan acak
	task.spawn(function()
		while model.Parent and hum and hum.Health > 0 do
			hum:MoveTo(randomPoint(0))
			task.wait(math.random(3, 6))
		end
	end)
	return true
end

---------------------------------------------------------------- efek
local function newPart(size, color, pos, anchored)
	local p = Instance.new("Part")
	p.Size = size
	p.Color = color
	p.Material = Enum.Material.Neon
	p.Position = pos
	p.Anchored = anchored or false
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
	p.Parent = Workspace
	return p
end

local function burst(pos, color, count, speed)
	local anchor = newPart(Vector3.new(0.5, 0.5, 0.5), color, pos, true)
	anchor.Transparency = 1
	local em = Instance.new("ParticleEmitter")
	em.Color = ColorSequence.new(color)
	em.Lifetime = NumberRange.new(0.8, 1.6)
	em.Speed = NumberRange.new(speed * 0.5, speed)
	em.SpreadAngle = Vector2.new(180, 180)
	em.Size = NumberSequence.new({ NumberSequenceKeypoint.new(0, 1.2), NumberSequenceKeypoint.new(1, 0) })
	em.LightEmission = 1
	em.Rate = 0
	em.Parent = anchor
	em:Emit(count)
	Debris:AddItem(anchor, 3)
end

local function rain(count, colors, size, life)
	for _ = 1, count do
		local color = colors[math.random(1, #colors)]
		local p = newPart(size, color, randomPoint(45 + math.random(0, 15)), false)
		p.Rotation = Vector3.new(math.random(0, 360), math.random(0, 360), 0)
		Debris:AddItem(p, life)
		task.wait(0.04)
	end
end

local PINK = { Color3.fromRGB(255, 80, 120), Color3.fromRGB(255, 120, 160), Color3.fromRGB(220, 30, 80) }
local RAINBOW = {
	Color3.fromRGB(255, 80, 80), Color3.fromRGB(255, 200, 60), Color3.fromRGB(80, 220, 120),
	Color3.fromRGB(80, 160, 255), Color3.fromRGB(190, 100, 255),
}

local EFFECTS = {}
function EFFECTS.rose_rain(a)
	rain(15 * a.params.intensity, PINK, Vector3.new(0.7, 0.2, 0.7), 8)
end
function EFFECTS.hearts(a)
	for _ = 1, 3 + a.params.intensity * 2 do
		burst(randomPoint(10 + math.random(0, 8)), PINK[math.random(1, #PINK)], 25, 20)
		task.wait(0.15)
	end
end
function EFFECTS.sparkle(a)
	for _ = 1, 2 + a.params.intensity do
		burst(randomPoint(6 + math.random(0, 6)), Color3.fromRGB(255, 240, 150), 20, 14)
		task.wait(0.1)
	end
end
function EFFECTS.confetti(a)
	rain(25 * a.params.intensity, RAINBOW, Vector3.new(0.5, 0.15, 0.9), 7)
end
function EFFECTS.fireworks(a)
	for _ = 1, 3 + a.params.intensity do
		local from = randomPoint(2)
		local rocket = newPart(Vector3.new(0.6, 1.5, 0.6), Color3.fromRGB(255, 255, 255), from, true)
		local top = from + Vector3.new(0, 35 + math.random(0, 15), 0)
		local tween = TweenService:Create(rocket, TweenInfo.new(0.9, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { Position = top })
		tween:Play()
		tween.Completed:Wait()
		rocket:Destroy()
		burst(top, RAINBOW[math.random(1, #RAINBOW)], 80, 45)
		task.wait(0.35)
	end
end
function EFFECTS.mega(a)
	task.spawn(function() EFFECTS.fireworks({ params = { intensity = 5 } }) end)
	rain(60, RAINBOW, Vector3.new(0.6, 0.2, 1), 9)
end
function EFFECTS.welcome(a)
	burst(randomPoint(8), Color3.fromRGB(120, 220, 255), 40, 18)
end

local function runEffect(a)
	a.params = a.params or {}
	a.params.intensity = math.clamp(tonumber(a.params.intensity) or 1, 1, 10)
	local fn = EFFECTS[a.effect]
	if not fn then
		warn("[TikTokBridge] efek tidak dikenal: " .. tostring(a.effect) .. " -> pakai confetti")
		fn = EFFECTS.confetti
	end
	task.spawn(fn, a)
	return true
end

---------------------------------------------------------------- dispatcher
local function handle(item)
	local p = item.payload or {}
	pcall(function() remote:FireAllClients(item.type, p) end) -- hook untuk UI di client
	if item.type == "spawn" then
		return spawnAvatar(p)
	elseif item.type == "effect" then
		return runEffect(p)
	end
	return false, "Tipe aksi tidak dikenal: " .. tostring(item.type)
end

---------------------------------------------------------------- loop utama
print("[TikTokBridge] mulai polling ke " .. CONFIG.BASE_URL .. " sebagai " .. WORKER_ID)
local failures = 0
while true do
	local res = api("/api/roblox/claim", { workerId = WORKER_ID, max = CONFIG.BATCH })
	if res and res.success then
		failures = 0
		local items = res.data and res.data.items or {}
		if #items > 0 then
			local results = {}
			for _, item in ipairs(items) do
				local ok, success, err = pcall(handle, item)
				if not ok then success, err = false, tostring(success) end
				table.insert(results, {
					id = item.id,
					status = success and "done" or "failed",
					error = (not success) and tostring(err or "gagal") or nil,
				})
			end
			api("/api/roblox/ack", { workerId = WORKER_ID, results = results })
		end
		task.wait(CONFIG.POLL_INTERVAL)
	else
		failures += 1
		task.wait(math.min(30, 2 + failures * 2)) -- backoff saat server tidak terjangkau
	end
end
