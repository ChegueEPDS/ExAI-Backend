const mongoose = require('mongoose');

const { Schema } = mongoose;

const QuestionTypeMappingSchema = new Schema(
  {
    tenantId: {
      type: Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true
    },
    // Opcionális emberi olvasható cím (nem kötelező)
    label: {
      type: String,
      required: false,
      trim: true
    },
    // Egyszerű, kisbetűs szöveg, amit az Equipment \"Equipment Type\" mezőjében keresünk (substring)
    equipmentPattern: {
      type: String,
      required: true,
      trim: true
    },
    // Mely question equipmentType csoportokra vonatkozik ez a mapping
    equipmentTypes: [
      {
        type: String,
        enum: [
          'General',
          'Motors',
          'Lighting',
          'Installation',
          'Installation Heating System',
          'Installation Motors',
          'Environment'
        ],
        required: true
      }
    ],
    active: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

QuestionTypeMappingSchema.index(
  { tenantId: 1, equipmentPattern: 1 },
  { unique: true, name: 'uniq_tenant_pattern' }
);

module.exports = mongoose.model('QuestionTypeMapping', QuestionTypeMappingSchema);
