const mongoose = require('mongoose');

const ZoneSchema = new mongoose.Schema(
    {
        Name: { type: String, required: true },
        Description: { type: String },
        Environment: { 
            type: String, 
            required: true, 
            enum: ['Gas', 'Dust', 'Hybrid', 'NonEx'] 
        },
        Zone: { 
            type: [Number], 
            enum: [0, 1, 2, 20, 21, 22],
            default: []
        },
        SubGroup: { 
            type: [String], 
            enum: ['IIA', 'IIB', 'IIC', 'IIIA', 'IIIB', 'IIIC'],
            default: []
        },
        TempClass: { 
            type: String, 
            enum: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'] 
        },
        MaxTemp: { type: Number },
        CreatedBy: { 
            type: mongoose.Schema.Types.ObjectId, 
            ref: 'User', 
        },
        ModifiedBy: {  // Új mező a módosító felhasználónak
            type: mongoose.Schema.Types.ObjectId, 
            ref: 'User'
        },
        Company: { 
            type: String,
        },
        Site: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Site',
        },
        oneDriveFolderUrl: { type: String },
        oneDriveFolderId: { type: String },
    }, 
    { timestamps: true }
);

// Pre-save hook: csak az új rekordoknál állítja be a Company-t
ZoneSchema.pre('save', async function (next) {
    if (!this.Company) {
        try {
            const user = await mongoose.model('User').findById(this.CreatedBy);
            if (!user) return next(new Error('Érvénytelen CreatedBy felhasználó.'));
            this.Company = user.company;
        } catch (error) {
            return next(error);
        }
    }
    next();
});

// Pre-update hook: minden módosításkor frissíti a ModifiedBy mezőt
ZoneSchema.pre('findOneAndUpdate', async function (next) {
    const update = this.getUpdate();
    if (!update) return next();

    if (update.$set && update.$set.ModifiedBy) {
        this.setUpdate({ ...update, $set: { ModifiedBy: update.$set.ModifiedBy } });
    }

    next();
});

module.exports = mongoose.model('Zone', ZoneSchema);