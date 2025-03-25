const mongoose = require('mongoose');

const SiteSchema = new mongoose.Schema({
    Name: { type: String, required: true },
    Client: { type: String, required: true },
    CreatedBy: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true 
    },
    Company: { 
        type: String, // Ha a company egy string (pl. cégnév vagy azonosító)
        required: true 
    },
    oneDriveFolderUrl: { type: String }, 
    oneDriveFolderId: { type: String },
}, { timestamps: true });

// Mielőtt mentenénk a Site modellt, beállítjuk a Company értékét a CreatedBy felhasználó alapján
SiteSchema.pre('save', async function (next) {
    if (!this.isModified('CreatedBy')) return next();

    try {
        // Lekérdezzük a felhasználót, aki létrehozta a Site-ot
        const user = await mongoose.model('User').findById(this.CreatedBy);
        if (!user) {
            return next(new Error('Invalid CreatedBy user'));
        }

        // Beállítjuk a Company mezőt a User modellből
        this.Company = user.company; // Feltételezzük, hogy a user objektumnak van `company` mezője

        next();
    } catch (error) {
        next(error);
    }
});

module.exports = mongoose.model('Site', SiteSchema);