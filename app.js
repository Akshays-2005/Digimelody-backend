const express = require('express');
const multer = require('multer');
const { MongoClient, GridFSBucket } = require('mongodb');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3000;
const MONGO_URI = "rm -r node_modules";
const DATABASE_NAME = "media_database";
const JWT_SECRET = "your_jwt_secret"; // Replace with a secure secret key

// Setup multer for file uploads (memory storage)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Enable CORS and JSON parsing
app.use(cors({ origin: '*' }));
app.use(express.json());

// MongoDB connection
let bucket;
let db;

MongoClient.connect(MONGO_URI)
    .then(client => {
        console.log("Connected to MongoDB");
        db = client.db(DATABASE_NAME);
        bucket = new GridFSBucket(db);
    })
    .catch(err => console.error("MongoDB connection error:", err));

/**
 * Middleware to authenticate routes
 */
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).send({ message: 'Access denied. Token missing.' });
    }

    jwt.verify(token, JWT_SECRET, (err) => {
        if (err) {
            console.error("Token error:", err.message);
            return res.status(403).send({ message: 'Invalid token.' });
        }
        next();
    });
}

// User registration route
app.post('/auth/register', async (req, res) => {
    const { fullname, email, username, password } = req.body;

    if (!fullname || !email || !username || !password) {
        return res.status(400).send({ message: 'All fields are required.' });
    }

    try {
        const existingUser = await db.collection('users').findOne({
            $or: [{ username }, { email }],
        });

        if (existingUser) {
            return res.status(400).send({ message: 'Username or email already exists.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = {
            fullname,
            email,
            username,
            password: hashedPassword,
            createdAt: new Date(),
        };

        await db.collection('users').insertOne(newUser);

        res.status(201).send({ message: 'User registered successfully.' });
    } catch (error) {
        console.error('Error during registration:', error);
        res.status(500).send({ message: 'Server error.' });
    }
});

// User login route
app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await db.collection('users').findOne({ username });
        if (!user) {
            return res.status(404).send({ message: 'User not found.' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(400).send({ message: 'Invalid credentials.' });
        }

        const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });
        res.status(200).send({ message: 'Login successful.', token });
    } catch (error) {
        console.error('Error logging in user:', error);
        res.status(500).send({ message: 'Server error.' });
    }
});

// Upload endpoint (protected)
app.post('/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).send({ message: 'No file uploaded.' });
    }

    const { title, artist, album, language } = req.body;
    if (!title || !artist || !album || !language) {
        return res.status(400).send({ message: 'All metadata fields are required.' });
    }

    const uploadStream = bucket.openUploadStream(req.file.originalname, {
        contentType: req.file.mimetype,
    });

    uploadStream.end(req.file.buffer);
    uploadStream.on('finish', () => {
        const songMetadata = {
            filename: req.file.originalname,
            title,
            artist,
            album,
            language,
            uploadDate: new Date(),
        };

        db.collection('songs').insertOne(songMetadata, (err) => {
            if (err) {
                return res.status(500).send({ message: 'Error saving song metadata.' });
            }

            res.status(200).send({ message: 'File uploaded successfully.' });
        });
    });

    uploadStream.on('error', err => {
        res.status(500).send({ message: 'File upload failed.', details: err });
    });
});

// Fetch songs filtered by language
app.get('/songs/:language', authenticateToken, async (req, res) => {
    const language = req.params.language;

    try {
        const songList = await db.collection('songs').find({ language }).toArray();

        if (songList.length === 0) {
            return res.status(404).send({ message: `No songs found for language: ${language}.` });
        }

        res.status(200).json(songList);
    } catch (err) {
        console.error('Error fetching song list:', err);
        res.status(500).send({ message: 'Failed to fetch song list.' });
    }
});

// Fetch songs filtered by artist
app.get('/songs', authenticateToken, async (req, res) => {
    const { artist } = req.query;

    if (!artist) {
        return res.status(400).send({ message: 'Artist parameter is required.' });
    }

    try {
        const songList = await db.collection('songs').find({ artist }).toArray();

        if (songList.length === 0) {
            return res.status(404).send({ message: `No songs found for artist: ${artist}.` });
        }

        res.status(200).json(songList);
    } catch (err) {
        console.error('Error fetching songs by artist:', err);
        res.status(500).send({ message: 'Failed to fetch songs by artist.' });
    }
});

// Fetch top artists (public endpoint) - returns only artist names and song counts
app.get('/top-artists', async (req, res) => {
    try {
        const artists = await db.collection('songs')
            .find({})
            .toArray();

        // Flatten artist names into individual entries
        const artistCounts = {};
        artists.forEach(song => {
            const artistList = song.artist.split(',').map(name => name.trim());
            artistList.forEach(artist => {
                if (artistCounts[artist]) {
                    artistCounts[artist]++;
                } else {
                    artistCounts[artist] = 1;
                }
            });
        });

        // Convert to an array and sort alphabetically
        const artistData = Object.keys(artistCounts)
            .map(artist => ({
                artistName: artist,
                songCount: artistCounts[artist],
            }))
            .sort((a, b) => a.artistName.localeCompare(b.artistName));

        res.status(200).json(artistData);
    } catch (error) {
        console.error('Error fetching top artists:', error);
        res.status(500).send({ message: 'Failed to fetch top artists.' });
    }
});

// Fetch songs for a specific artist
app.get('/artist/:artistName/songs', async (req, res) => {
    const { artistName } = req.params;

    try {
        const songs = await db.collection('songs').find({ artist: artistName }).toArray();

        if (!songs.length) {
            return res.status(404).send({ message: `No songs found for artist: ${artistName}.` });
        }

        res.status(200).json(songs);
    } catch (error) {
        console.error('Error fetching songs by artist:', error);
        res.status(500).send({ message: 'Failed to fetch songs by artist.' });
    }
});

// Stream song file by filename (protected)
app.get('/play/:filename', authenticateToken, async (req, res) => {
    const filename = req.params.filename;

    try {
        const files = await bucket.find({ filename }).toArray();
        if (!files.length) {
            return res.status(404).send({ message: 'File not found.' });
        }

        console.log('Serving file:', filename);

        const downloadStream = bucket.openDownloadStreamByName(filename);
        res.set({
            'Content-Type': files[0].contentType || 'audio/mpeg',
            'Accept-Ranges': 'bytes',
        });

        downloadStream.pipe(res);
    } catch (err) {
        console.error('Error streaming file:', err);
        res.status(500).send({ message: 'Error playing file.' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
