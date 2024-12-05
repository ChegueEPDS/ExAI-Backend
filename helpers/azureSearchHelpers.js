const axios = require('axios');

exports.fetchFromAzureSearch = async (query) => {
    const body = {
      search: query,
    //  select: "category,category_comment,unit,item_number,item,type_number,item_type,notes,quantity,unit_measurement" // Csak ezek a mezők kerülnek vissza

    };
  
    const response = await axios.post(
      `${process.env.AZURE_SEARCH_URL}/indexes/${process.env.AZURE_INDEX_NAME}/docs/search?api-version=2021-04-30-Preview`,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': process.env.AZURE_API_KEY,
        },
      }
    );
  
    return response.data.value;
  };