// Massachusetts center coordinates (longitude, latitude)
        const massCenter = [-71.8, 42.25];

        // WKT rectangle
        const wkt = 'POLYGON((-71.5 42.0, -72.5 42.0, -72.5 42.5, -71.5 42.5, -71.5 42.0))';
        const format = new ol.format.WKT();
        const feature = format.readFeature(wkt, {
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857'
        });
        
        const vectorSource = new ol.source.Vector({
            features: [feature]
        });
        
        const vectorLayer = new ol.layer.Vector({
            source: vectorSource,
            style: new ol.style.Style({
                stroke: new ol.style.Stroke({
                    color: 'red',
                    width: 2
                }),
                fill: new ol.style.Fill({
                    color: 'rgba(255, 0, 0, 0.1)'
                })
            })
        });
        
        
        // Create the map
        const map = new ol.Map({
            target: 'map',
            layers: [
                new ol.layer.Tile({
                    source: new ol.source.OSM()
                }),
                vectorLayer
            ],
            view: new ol.View({
                center: ol.proj.fromLonLat(massCenter),
                zoom: 8
            })
        });